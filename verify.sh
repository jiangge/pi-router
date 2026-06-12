#!/bin/bash
# Quick verification script for pi-router

set -e

echo "🔍 Pi-Router Quick Verification"
echo "================================"
echo ""

# Check if pi is available
if ! command -v pi &> /dev/null; then
    echo "❌ pi command not found. Please install pi first."
    exit 1
fi
echo "✅ pi command found"

# Check if extension is symlinked
if [ -L "$HOME/.pi/agent/extensions/pi-router" ]; then
    echo "✅ Extension symlinked to ~/.pi/agent/extensions/pi-router"
else
    echo "⚠️  Extension not symlinked. Creating symlink..."
    mkdir -p "$HOME/.pi/agent/extensions"
    ln -sf "$(pwd)" "$HOME/.pi/agent/extensions/pi-router"
    echo "✅ Symlink created"
fi

# Check if built
if [ -f "dist/index.js" ]; then
    echo "✅ Extension built (dist/index.js exists)"
else
    echo "⚠️  Extension not built. Building..."
    npm run build
    echo "✅ Build complete"
fi

# Check package.json
if grep -q "pi-package" package.json; then
    echo "✅ package.json has 'pi-package' keyword"
else
    echo "❌ package.json missing 'pi-package' keyword"
    exit 1
fi

if grep -q '"pi":' package.json; then
    echo "✅ package.json has 'pi' manifest"
else
    echo "❌ package.json missing 'pi' manifest"
    exit 1
fi

# Check documentation
echo ""
echo "📚 Documentation Check:"
for doc in README.md README.zh-CN.md CHANGELOG.md INSTALL.md ARCHITECTURE.md TESTING.md; do
    if [ -f "$doc" ]; then
        echo "  ✅ $doc"
    else
        echo "  ❌ $doc missing"
    fi
done

# Check examples
echo ""
echo "📂 Examples Check:"
for example in examples/router.config.json examples/router.config.minimal.json; do
    if [ -f "$example" ]; then
        echo "  ✅ $example"
    else
        echo "  ❌ $example missing"
    fi
done

# Check npm pack
echo ""
echo "📦 Package Check:"
npm pack --dry-run > /tmp/pi-router-pack.txt 2>&1
file_count=$(grep "total files:" /tmp/pi-router-pack.txt | awk '{print $NF}')
pack_size=$(grep "package size:" /tmp/pi-router-pack.txt | awk '{print $3, $4}')

echo "  Files: $file_count"
echo "  Size: $pack_size"

if [ "$file_count" -ge 10 ]; then
    echo "  ✅ Package contains expected files"
else
    echo "  ⚠️  Package has fewer files than expected"
fi

# Version check
version=$(grep '"version":' package.json | head -1 | sed 's/.*: "\(.*\)".*/\1/')
echo ""
echo "📌 Current Version: $version"

# Git status
echo ""
echo "📊 Git Status:"
if [ -z "$(git status --porcelain)" ]; then
    echo "  ✅ Working directory clean"
else
    echo "  ⚠️  Uncommitted changes:"
    git status --short
fi

# Summary
echo ""
echo "================================"
echo "✅ Basic verification complete!"
echo ""
echo "Next steps:"
echo "  1. Test in pi: Start pi and verify extension loads"
echo "  2. Create test config: cp examples/router.config.minimal.json ~/.pi/agent/router.config.json"
echo "  3. Run commands: /router status, /router list"
echo "  4. See TESTING.md for full test scenarios"
echo "  5. When ready: npm publish"
echo ""
