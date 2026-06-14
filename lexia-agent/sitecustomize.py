import os

# Disable auto-loading of external pytest plugins which may cause import errors in the execution environment.
# This is safe for the project's own tests.
os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
