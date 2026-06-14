#!/usr/bin/env python3
"""
Encrypt all .md prompt templates to .md.enc using Fernet symmetric encryption.

Usage:
    # Generate a new key and encrypt all prompts
    python scripts/encrypt_prompts.py

    # Use an existing key (e.g. from CI secrets)
    LEXIA_BUILD_KEY=<base64-key> python scripts/encrypt_prompts.py

    # Encrypt and inject key into prompt_loader.py (for Cython compilation)
    python scripts/encrypt_prompts.py --inject-key

The key is printed to stdout so you can save it for future builds.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

from cryptography.fernet import Fernet


def find_prompt_files(root: Path) -> list[Path]:
    """Find all .md files under prompts/ that should be encrypted."""
    prompts_dir = root / "prompts"
    if not prompts_dir.is_dir():
        return []
    return sorted(prompts_dir.rglob("*.md"))


def encrypt_files(files: list[Path], key: bytes) -> int:
    """Encrypt each .md file to .md.enc. Returns count of encrypted files."""
    cipher = Fernet(key)
    count = 0
    for md_path in files:
        plaintext = md_path.read_bytes()
        enc_path = md_path.with_suffix(".md.enc")
        enc_path.write_bytes(cipher.encrypt(plaintext))
        count += 1
    return count


def remove_plaintext(files: list[Path]) -> None:
    """Remove the original .md files after encryption."""
    for md_path in files:
        md_path.unlink(missing_ok=True)


def inject_key_into_loader(root: Path, key: bytes) -> bool:
    """Replace the _PROMPT_KEY placeholder in prompt_loader.py with the real key.

    This must be done BEFORE Cython compilation so the key is baked into the .so.
    """
    loader = root / "prompt_loader.py"
    if not loader.is_file():
        print(f"WARNING: {loader} not found, skipping key injection", file=sys.stderr)
        return False

    content = loader.read_text(encoding="utf-8")
    # Replace the placeholder line
    new_content = re.sub(
        r'^_PROMPT_KEY:\s*Optional\[bytes\]\s*=\s*None\b.*$',
        f'_PROMPT_KEY: Optional[bytes] = {key!r}',
        content,
        count=1,
        flags=re.MULTILINE,
    )
    if new_content == content:
        print("WARNING: Could not find _PROMPT_KEY placeholder in prompt_loader.py", file=sys.stderr)
        return False

    loader.write_text(new_content, encoding="utf-8")
    return True


def main():
    parser = argparse.ArgumentParser(description="Encrypt prompt templates for release builds")
    parser.add_argument("--inject-key", action="store_true",
                        help="Inject the encryption key into prompt_loader.py")
    parser.add_argument("--remove-plaintext", action="store_true",
                        help="Remove original .md files after encryption")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent,
                        help="Project root directory (default: auto-detect)")
    args = parser.parse_args()

    root = args.root.resolve()
    print(f"Project root: {root}")

    # Get or generate key
    key_env = os.environ.get("LEXIA_BUILD_KEY")
    if key_env:
        key = key_env.encode() if isinstance(key_env, str) else key_env
        print("Using key from LEXIA_BUILD_KEY environment variable")
    else:
        key = Fernet.generate_key()
        print("Generated new encryption key")

    print(f"KEY: {key.decode()}")

    # Find and encrypt
    files = find_prompt_files(root)
    if not files:
        print("No .md files found under prompts/", file=sys.stderr)
        sys.exit(1)

    count = encrypt_files(files, key)
    print(f"Encrypted {count} prompt files")

    # Inject key into prompt_loader.py
    if args.inject_key:
        if inject_key_into_loader(root, key):
            print("Injected key into prompt_loader.py")
        else:
            print("WARNING: Key injection failed", file=sys.stderr)

    # Remove plaintext
    if args.remove_plaintext:
        remove_plaintext(files)
        print(f"Removed {count} plaintext .md files")


if __name__ == "__main__":
    main()
