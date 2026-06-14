#!/usr/bin/env python3
"""
Safe sandbox for executing Python scripts related to Parquet file operations.
Restricts execution to safe operations only - no network, no system calls, limited file access.
"""

import sys
import os
import ast
import types
import traceback
from pathlib import Path
from io import StringIO
import contextlib


class ParquetSandboxError(Exception):
    """Exception raised for sandbox security violations."""

    pass


class RestrictedImportFinder:
    """Custom import hook to restrict module imports."""

    ALLOWED_MODULES = {
        # Core data processing
        "pandas",
        "pd",
        "numpy",
        "np",
        "pyarrow",
        "pa",
        "pyarrow.compute",
        "pyarrow.parquet",
        "pyarrow.dataset",
        "pyarrow.lib",
        "pyarrow._parquet",
        # PyArrow dependencies
        "substrait",
        "pandas.core",
        "pandas.core.frame",
        "pandas.core.series",
        "pandas.core.indexes",
        "pandas.core.arrays",
        "pandas._libs",
        "pandas._libs.lib",
        "pandas._libs.tslibs",
        "pandas._libs.tslibs.timestamps",
        "numpy.core",
        "numpy.core.multiarray",
        "numpy.core._multiarray_umath",
        "numpy.linalg",
        "numpy.random",
        "numpy.fft",
        "numpy.polynomial",
        "numpy.lib",
        "numpy.lib.format",
        "numpy.lib.stride_tricks",
        "numpy.lib._datasource",
        "numpy.matrixlib",
        "numpy.ctypeslib",
        "numpy.ma",
        "numpy.ma.core",
        "numpy.compat",
        "numpy.compat.py3k",
        # Standard library - safe modules
        "json",
        "csv",
        "io",
        "re",
        "math",
        "random",
        "datetime",
        "decimal",
        "fractions",
        "collections",
        "itertools",
        "functools",
        "operator",
        "statistics",
        "typing",
        "pathlib",
        "hashlib",
        "uuid",
        "string",
        "textwrap",
        "copy",
        "pprint",
        "warnings",
        "abc",
        "dataclasses",
        "enum",
        "numbers",
        "inspect",
        "types",
        "builtins",
        "__future__",
        # Parquet-related
        "fastparquet",
    }

    BLOCKED_MODULES = {
        "os",
        "sys",
        "subprocess",
        "socket",
        "urllib",
        "http",
        "ftplib",
        "smtplib",
        "requests",
        "urllib3",
        "pycurl",
        "paramiko",
        "telnetlib",
        "ssl",
        "imaplib",
        "nntplib",
        "poplib",
        "smtpd",
        "socketserver",
        "xmlrpc",
        "shlex",
        "multiprocessing",
        "threading",
        "concurrent",
        "asyncio",
        "select",
        "selectors",
        "signal",
        "mmap",
        "resource",
        "ctypes",
        "ctypeslib",
        "_ctypes",
        "cffi",
        "pickle",
        "cPickle",
        "marshal",
        "shelve",
        "dbm",
        "sqlite3",
        "psycopg2",
        "pymysql",
        "sqlalchemy",
        "pymongo",
        "redis",
        "boto3",
        "botocore",
        "azure",
        "google",
        "facebook",
        "twitter",
        "instagram",
        "linkedin",
        "github",
        "matplotlib",
        "seaborn",
        "plotly",
        "bokeh",
        "altair",
        "pygal",
        "tkinter",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "wx",
        "kivy",
        "django",
        "flask",
        "fastapi",
        "tornado",
        "bottle",
        "web2py",
    }

    def find_module(self, fullname, path=None):
        """Check if module import is allowed."""
        base_module = fullname.split(".")[0]
        if base_module in self.BLOCKED_MODULES:
            raise ParquetSandboxError(f"Import of '{fullname}' is blocked")
        if base_module not in self.ALLOWED_MODULES:
            raise ParquetSandboxError(f"Import of '{fullname}' is not allowed")
        return None


class SafeCodeChecker(ast.NodeVisitor):
    """AST visitor to check for dangerous code patterns."""

    DANGEROUS_NAMES = {
        "eval",
        "exec",
        "compile",
        "__import__",
        "open",
        "input",
        "exit",
        "quit",
        "breakpoint",
        "os",
        "sys",
        "subprocess",
        "socket",
        "urllib",
        "requests",
        "os.system",
        "os.remove",
        "os.rmdir",
    }

    def __init__(self):
        self.issues = []

    def visit_Call(self, node):
        if isinstance(node.func, ast.Name):
            if node.func.id in self.DANGEROUS_NAMES:
                self.issues.append(f"Dangerous function call: {node.func.id}")
        self.generic_visit(node)

    def visit_Import(self, node):
        for alias in node.names:
            base_module = alias.name.split(".")[0]
            if base_module in RestrictedImportFinder.BLOCKED_MODULES:
                self.issues.append(f"Blocked import: {alias.name}")
        self.generic_visit(node)


def check_code_safety(code):
    """Check code for dangerous patterns using AST analysis."""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise ParquetSandboxError(f"Syntax error: {e}")

    checker = SafeCodeChecker()
    checker.visit(tree)

    if checker.issues:
        raise ParquetSandboxError(
            f"Security issues:\n" + "\n".join(f"  - {i}" for i in checker.issues)
        )
    return tree


def create_safe_locals(data_dir=None):
    """Create a restricted locals dictionary with safe imports and data pre-loaded."""
    safe_locals = {}

    # Import and add pandas, numpy, pyarrow
    try:
        import pandas as pd

        safe_locals["pd"] = pd
        safe_locals["pandas"] = pd
    except ImportError:
        pass

    try:
        import numpy as np

        safe_locals["np"] = np
        safe_locals["numpy"] = np
    except ImportError:
        pass

    try:
        import pyarrow as pa

        safe_locals["pa"] = pa
        safe_locals["pyarrow"] = pa
    except ImportError:
        pass

    # Pre-load all parquet files into dfs dictionary
    try:
        import pandas as pd
        from pathlib import Path

        dfs = {}
        if data_dir:
            data_path = Path(data_dir)
            if data_path.exists() and data_path.is_dir():
                for parquet_file in data_path.glob("*.parquet"):
                    # Skip embeddings files
                    if "_embeddings" in parquet_file.name:
                        continue
                    try:
                        table_name = (
                            parquet_file.stem
                        )  # Use filename without extension as table name
                        # For parquet files with sql_bambinos_db_ prefix, use simpler name
                        if table_name.startswith("sql_bambinos_db_"):
                            table_name = table_name.replace("sql_bambinos_db_", "")

                        df = pd.read_parquet(parquet_file)
                        dfs[table_name] = df
                    except Exception:
                        pass

        safe_locals["dfs"] = dfs
    except Exception:
        pass

    return safe_locals


def run_sandboxed_code(code, timeout=30, data_dir=None):
    """
    Run Python code in a restricted sandbox environment.

    Args:
        code: Python code string to execute
        timeout: Maximum execution time in seconds
        data_dir: Optional directory containing parquet files to pre-load into dfs

    Returns:
        dict with 'success', 'output', 'error', and 'result' keys
    """
    try:
        check_code_safety(code)
    except ParquetSandboxError as e:
        return {"success": False, "output": "", "error": str(e), "result": None}

    safe_locals = create_safe_locals(data_dir)
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    stdout_capture = StringIO()
    stderr_capture = StringIO()
    result = None

    try:
        sys.stdout = stdout_capture
        sys.stderr = stderr_capture

        # Create restricted globals with safe builtins
        import builtins

        safe_builtins = {}
        for name in dir(builtins):
            if not name.startswith("_"):
                safe_builtins[name] = getattr(builtins, name)

        # Add __import__ explicitly (needed for module imports)
        if hasattr(builtins, "__import__"):
            safe_builtins["__import__"] = builtins.__import__

        # Remove dangerous builtins
        dangerous_names = [
            "eval",
            "exec",
            "compile",
            "open",
            "input",
            "raw_input",
            "quit",
            "exit",
            "help",
            "license",
            "copyright",
            "credits",
        ]
        for name in dangerous_names:
            safe_builtins.pop(name, None)

        # Check if code tries to import blocked modules (sys, subprocess, os)
        for banned in ["sys", "subprocess", "socket", "os"]:
            if f"import {banned}" in code:
                raise ParquetSandboxError(f"Blocked import: {banned}")

        # Create restricted globals with safe builtins
        restricted_globals = {
            "__builtins__": safe_builtins,
            "__name__": "__sandbox__",
        }

        # Merge safe_locals into restricted_globals so pd, np, etc. are accessible
        for key, value in safe_locals.items():
            restricted_globals[key] = value

        # Execute the code with the sandbox globals
        exec(code, restricted_globals)

        # Get result if defined
        if "result" in safe_locals:
            result = safe_locals["result"]

        success = True
        error = None

    except Exception as e:
        success = False
        error = f"{type(e).__name__}: {e}"
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        if sys.meta_path and hasattr(sys.meta_path[0], "__class__"):
            if sys.meta_path[0].__class__.__name__ == "RestrictedImportFinder":
                sys.meta_path.pop(0)

    return {
        "success": success,
        "output": stdout_capture.getvalue(),
        "error": error,
        "stderr": stderr_capture.getvalue(),
        "result": result,
    }


def main():
    """CLI entry point for running scripts in sandbox."""
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Run Python script in sandbox")
    parser.add_argument("script_path", help="Path to Python script to execute")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout in seconds")
    parser.add_argument(
        "--data-dir",
        type=str,
        default="data",
        help="Directory containing parquet files",
    )
    args = parser.parse_args()

    script_path = Path(args.script_path)
    if not script_path.exists():
        print(f"Error: Script not found: {script_path}", file=sys.stderr)
        sys.exit(1)

    code = script_path.read_text()
    result = run_sandboxed_code(code, timeout=args.timeout, data_dir=args.data_dir)

    # Print output
    if result["output"]:
        print(result["output"])

    # Print result as JSON for parsing
    if result["result"]:
        print(f"\nResult: {json.dumps(result['result'])}")

    # Exit with error code if failed
    if not result["success"]:
        if result["error"]:
            print(f"Error: {result['error']}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
