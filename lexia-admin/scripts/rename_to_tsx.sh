#!/bin/bash
find src -name "*.jsx" -exec sh -c 'mv "$0" "${0%.jsx}.tsx"' {} \;
find src/lib -name "*.js" -exec sh -c 'mv "$0" "${0%.js}.ts"' {} \;
find src/hooks -name "*.js" -exec sh -c 'mv "$0" "${0%.js}.ts"' {} \;
find src/constants -name "*.js" -exec sh -c 'mv "$0" "${0%.js}.ts"' {} \;
