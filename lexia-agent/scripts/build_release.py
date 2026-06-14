#!/usr/bin/env python3
"""
Build Release — Cython compilation pipeline for IP-protected distribution.

This script:
  1. Copies the source tree to a build directory (excluding dev artifacts)
  2. Encrypts all .md prompt templates (Fernet) and injects the key
  3. Compiles every .py file to a native .so via Cython
  4. Removes all .py source files (only .so remain)
  5. Outputs a clean release tree ready for Docker packaging

Usage:
    # Full build (run inside brikz-agent/)
    python scripts/build_release.py

    # With explicit output directory
    python scripts/build_release.py --output /tmp/release

    # Re-use an existing encryption key
    LEXIA_BUILD_KEY=<key> python scripts/build_release.py

Environment Variables:
    LEXIA_BUILD_KEY  — Fernet key for prompt encryption (generated if absent)
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# ── Configuration ────────────────────────────────────────────────────────────

# Directories/files to EXCLUDE from the release tree entirely
EXCLUDE_DIRS = {
    ".venv", "venv", "__pycache__", ".git", ".github", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", "node_modules", ".tox",
    "scripts",  # build scripts themselves are not shipped
    "build", "dist",  # prior build artifacts
    "tests",  # test suites don't ship
}

EXCLUDE_FILES = {
    ".env", ".env.local", ".env.production",
    ".gitignore", ".python-version",
    "CLAUDE.md", "README.md",
    "Dockerfile", "Dockerfile.release",
    "Makefile",
    "uv.lock",
}

# Files to keep as .py (not compiled).
# Cython 3 enforces strict static name resolution and will reject modules that
# reference undefined names (missing imports, `shared` used outside scope, …).
# The following modules contain such latent bugs and currently cannot be
# cythonized — they ship as .py source. TODO: refactor these to allow full
# Cython compilation.
KEEP_AS_PY: set[str] = {
    # Latent undefined-name bugs Cython rejects (missing imports / out-of-scope
    # references). Ship as .py for now; refactor later for full protection.
    "agents/finance_agent.py",
    "nodes/requirements_analysis_node.py",
    "nodes/agents/consensus_node.py",
    "nodes/agents/challenger_node.py",
    "nodes/agents/proposer_node.py",
    "nodes/analysis_node.py",
    "flows/analysis_flow.py",
    "services/dataframe_services.py",
    # Pydantic BaseModel with methods: Cython turns methods into `cyfunction`
    # objects that Pydantic mistakes for unannotated fields. Low-IP schema.
    "data/classes/columns_classes.py",
}

# Entire directories whose .py files must ship as plaintext source.
# These are runtime-editable metadata (column descriptions, types,
# is_categorical flags) mutated via the /parquet/columns/schema API.
# If we compiled them to .so, CPython's import machinery would pick the
# stale .so over our freshly-written .py and the UI edits would silently
# vanish. Low IP value — they are auto-generated DTO column definitions.
KEEP_AS_PY_DIRS: tuple[str, ...] = (
    "data/classes/dtos",
)


def _should_keep_as_py(rel_path: Path) -> bool:
    """True if *rel_path* must ship as .py (no Cython compilation)."""
    rel_str = str(rel_path).replace(os.sep, "/")
    if rel_str in KEEP_AS_PY:
        return True
    return any(
        rel_str == d or rel_str.startswith(f"{d}/")
        for d in KEEP_AS_PY_DIRS
    )


def _log(msg: str) -> None:
    print(f"[build_release] {msg}", flush=True)


# ── Step 1: Copy source tree ────────────────────────────────────────────────

def copy_source(src: Path, dst: Path) -> None:
    """Copy the source tree excluding dev-only directories and files."""
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)

    # Inside data/ we only keep Python source (DTOs, classes), small yaml configs,
    # the reporting CTE SQL catalog, and optional profile registry JSON.
    # Everything else (parquet, memory, conversations, outputs, …) is runtime state
    # and must NOT ship. Keep this list in sync with create_runtime_dirs() and
    # docker-entrypoint.sh seed paths under /opt/brikz-seed/.
    DATA_KEEP_DIRS = {"classes", "cte_graphs","reporting"}
    DATA_KEEP_FILES = {"__init__.py", "apf_fields.yaml", "cte_graph_profiles.json"}

    def _ignore(directory: str, contents: list[str]) -> set[str]:
        ignored = set()
        rel = Path(directory).relative_to(src)
        for name in contents:
            full = Path(directory) / name
            if name in EXCLUDE_DIRS and full.is_dir():
                ignored.add(name)
            elif name in EXCLUDE_FILES:
                ignored.add(name)
            elif name.endswith(".pyc"):
                ignored.add(name)
            elif rel == Path("data") and full.is_dir() and name not in DATA_KEEP_DIRS:
                ignored.add(name)
            elif rel == Path("data") and full.is_file() and name not in DATA_KEEP_FILES:
                ignored.add(name)
        return ignored

    shutil.copytree(src, dst, ignore=_ignore, dirs_exist_ok=True)
    _log(f"Copied source to {dst}")

    # Special-case: rename root config.py -> _yaml_config.py so Cython compiles
    # it with PyInit__yaml_config (matches the name used by config/__init__.py's
    # spec_from_file_location call in release builds).
    root_config = dst / "config.py"
    if root_config.is_file():
        root_config.rename(dst / "_yaml_config.py")
        _log("Renamed root config.py -> _yaml_config.py for Cython module-name match")


# ── Step 2: Encrypt prompts ─────────────────────────────────────────────────

def encrypt_prompts(build_dir: Path) -> bytes:
    """Encrypt all .md prompt files and inject key into prompt_loader.py.

    Returns the Fernet key used.
    """
    # Import the encrypt_prompts module from the source scripts dir
    encrypt_script = Path(__file__).resolve().parent / "encrypt_prompts.py"
    spec = importlib.util.spec_from_file_location("encrypt_prompts_mod", encrypt_script)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    from cryptography.fernet import Fernet

    key_env = os.environ.get("LEXIA_BUILD_KEY")
    if key_env:
        key = key_env.encode() if isinstance(key_env, str) else key_env
        _log("Using encryption key from LEXIA_BUILD_KEY")
    else:
        key = Fernet.generate_key()
        _log("Generated new encryption key")

    _log(f"Encryption key: {key.decode()}")

    files = mod.find_prompt_files(build_dir)
    count = mod.encrypt_files(files, key)
    _log(f"Encrypted {count} prompt templates")

    if mod.inject_key_into_loader(build_dir, key):
        _log("Injected key into prompt_loader.py")
    else:
        _log("WARNING: Key injection into prompt_loader.py failed")

    mod.remove_plaintext(files)
    _log(f"Removed {count} plaintext .md files")

    return key


# ── Step 3: Cython compilation ───────────────────────────────────────────────

def _collect_py_files(build_dir: Path) -> list[Path]:
    """Collect all .py files to compile, excluding those flagged KEEP_AS_PY."""
    py_files = []
    for py_file in sorted(build_dir.rglob("*.py")):
        rel = py_file.relative_to(build_dir)
        if _should_keep_as_py(rel):
            continue
        # Skip setup files that might interfere
        if py_file.name in ("setup.py", "_cython_setup.py"):
            continue
        py_files.append(py_file)
    return py_files


def compile_with_cython(build_dir: Path) -> int:
    """Compile all .py files to .so using Cython + setuptools.

    Returns count of successfully compiled modules.
    """
    py_files = _collect_py_files(build_dir)
    if not py_files:
        _log("No .py files to compile")
        return 0

    _log(f"Compiling {len(py_files)} Python files with Cython...")

    # Generate setup.py for cythonize
    setup_path = build_dir / "_cython_setup.py"
    extensions_lines = []
    for py_file in py_files:
        rel = py_file.relative_to(build_dir)
        # Module name: path/to/file.py → path.to.file
        module_name = str(rel.with_suffix("")).replace(os.sep, ".")
        extensions_lines.append(
            f'    Extension("{module_name}", ["{rel}"]),'
        )

    # Cythonize one file at a time so a single failure doesn't abort the batch
    # (Cython's parallel pool swallows individual errors otherwise).
    # `packages=[]` + `py_modules=[]` disables setuptools auto-discovery which
    # would otherwise fail on our non-standard layout.
    setup_content = f"""\
import os, sys
os.chdir({str(build_dir)!r})

from setuptools import setup, Extension
from Cython.Build import cythonize

MODULE = sys.argv[1]
SRC    = sys.argv[2]
sys.argv = [sys.argv[0], "build_ext", "--inplace"]

setup(
    name=MODULE,
    packages=[],
    py_modules=[],
    ext_modules=cythonize(
        [Extension(MODULE, [SRC])],
        compiler_directives={{
            "language_level": "3",
            "boundscheck": False,
            "wraparound": False,
            # Treat type hints as documentation only — required for FastAPI
            # (`param: str = Query(None)`) and Pydantic models.
            "annotation_typing": False,
            # Late-bind module-level names to match CPython semantics.
            "binding": True,
        }},
        nthreads=1,
        quiet=True,
    ),
)
"""
    setup_path.write_text(setup_content, encoding="utf-8")

    compiled = 0
    failed: list[tuple[str, str]] = []
    for py_file in py_files:
        rel = py_file.relative_to(build_dir)
        module_name = str(rel.with_suffix("")).replace(os.sep, ".")
        result = subprocess.run(
            [sys.executable, str(setup_path), module_name, str(rel)],
            cwd=str(build_dir),
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            # Keep only the most useful tail of the error
            err = (result.stderr or result.stdout or "").strip()
            tail = "\n".join(err.splitlines()[-12:])
            failed.append((module_name, tail))
        else:
            compiled += 1

    _log(f"Cython: {compiled}/{len(py_files)} modules compiled successfully")
    if failed:
        _log(f"Cython: {len(failed)} modules failed:")
        for mod, err in failed[:30]:
            _log(f"  ✗ {mod}")
            for line in err.splitlines()[-4:]:
                _log(f"      {line}")
        if len(failed) > 30:
            _log(f"  … and {len(failed) - 30} more")

    # Count .so files produced
    so_files = list(build_dir.rglob("*.so"))
    _log(f"Produced {len(so_files)} .so files")

    # Clean up setup file and build artifacts
    setup_path.unlink(missing_ok=True)
    build_subdir = build_dir / "build"
    if build_subdir.exists():
        shutil.rmtree(build_subdir)

    # Clean up .c files generated by Cython
    for c_file in build_dir.rglob("*.c"):
        c_file.unlink(missing_ok=True)

    return len(so_files)


# ── Step 4: Remove .py source files ─────────────────────────────────────────

def remove_py_sources(build_dir: Path) -> int:
    """Remove all .py files that have a corresponding .so.

    Returns count of removed files.
    """
    removed = 0
    for py_file in sorted(build_dir.rglob("*.py")):
        rel = py_file.relative_to(build_dir)
        if _should_keep_as_py(rel):
            continue
        # Check if a .so exists for this module
        stem = py_file.stem
        so_pattern = f"{stem}.cpython-*.so"
        so_files = list(py_file.parent.glob(so_pattern))
        if so_files:
            py_file.unlink()
            removed += 1
    _log(f"Removed {removed} .py source files")
    return removed


# ── Step 5: Create runtime directories ───────────────────────────────────────

def create_runtime_dirs(release_dir: Path) -> None:
    """Create empty data directories that the app expects at runtime."""
    for subdir in [
        "data/subagents", "data/outputs", "data/parquet",
        "data/memory", "data/embeddings", "data/graph",
        "data/conversations", "data/query_cache", "data/cte_graphs",
        "logs",
    ]:
        (release_dir / subdir).mkdir(parents=True, exist_ok=True)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Build IP-protected release")
    parser.add_argument(
        "--output", type=Path, default=None,
        help="Output directory for release artifacts (default: build/release/)",
    )
    parser.add_argument(
        "--source", type=Path, default=Path(__file__).resolve().parent.parent,
        help="Source directory (default: auto-detect project root)",
    )
    parser.add_argument(
        "--skip-encrypt", action="store_true",
        help="Skip prompt encryption (for testing)",
    )
    args = parser.parse_args()

    src = args.source.resolve()
    release_dir = (args.output or src / "build" / "release").resolve()

    _log(f"Source: {src}")
    _log(f"Output: {release_dir}")
    _log(f"Platform: {platform.system()} {platform.machine()}")
    _log(f"Python: {sys.version}")

    # Verify Cython is available
    try:
        import Cython
        _log(f"Cython version: {Cython.__version__}")
    except ImportError:
        _log("ERROR: Cython not installed. Run: pip install cython setuptools")
        sys.exit(1)

    # Step 1: Copy source tree
    build_dir = src / "build" / "_build_tmp"
    copy_source(src, build_dir)

    # Step 2: Encrypt prompts
    if not args.skip_encrypt:
        try:
            key = encrypt_prompts(build_dir)
            _log("SAVE THIS KEY for future builds: " + key.decode())
        except Exception as exc:
            _log(f"WARNING: Prompt encryption failed: {exc}")
            _log("Continuing without encryption...")
    else:
        _log("Skipping prompt encryption (--skip-encrypt)")

    # Step 3: Compile with Cython
    so_count = compile_with_cython(build_dir)
    if so_count == 0:
        _log("ERROR: No .so files produced — aborting")
        sys.exit(1)

    # Step 4: Remove .py source files
    remove_py_sources(build_dir)

    # Step 5: Move to release directory
    if release_dir.exists():
        shutil.rmtree(release_dir)
    shutil.move(str(build_dir), str(release_dir))

    # Step 6: Create runtime directories
    create_runtime_dirs(release_dir)

    # Summary
    remaining_py = list(release_dir.rglob("*.py"))
    so_files = list(release_dir.rglob("*.so"))
    enc_files = list(release_dir.rglob("*.md.enc"))
    plain_md = list(release_dir.rglob("*.md"))

    _log("=" * 60)
    _log("BUILD COMPLETE")
    _log("=" * 60)
    _log(f"  .so files:    {len(so_files)}")
    _log(f"  .py remaining: {len(remaining_py)}")
    if remaining_py:
        for f in remaining_py[:10]:
            _log(f"    - {f.relative_to(release_dir)}")
    _log(f"  .md.enc files: {len(enc_files)}")
    _log(f"  .md plaintext: {len(plain_md)}")
    if plain_md:
        for f in plain_md[:5]:
            _log(f"    - {f.relative_to(release_dir)}")
    _log(f"  Output: {release_dir}")

    # Clean up temp build dir if it still exists
    tmp_build = src / "build" / "_build_tmp"
    if tmp_build.exists():
        shutil.rmtree(tmp_build, ignore_errors=True)


if __name__ == "__main__":
    main()
