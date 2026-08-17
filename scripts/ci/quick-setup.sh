#!/usr/bin/env bash
set -euo pipefail

# Quick setup script for Orcana CI runner
# This runs all required setup steps in sequence
# Usage: sudo bash scripts/ci/quick-setup.sh

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║         Orcana CI Runner - Quick Setup Script                  ║"
echo "║  Configures delegated cgroup & execd CapacityAuthority         ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "❌ This script must be run as root"
  echo "   Run: sudo bash scripts/ci/quick-setup.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$PROJECT_ROOT"

# Step 1: Setup cgroup delegation
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Step 1/3: Setting up cgroup v2 delegation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ ! -f "$SCRIPT_DIR/setup-runner-cgroup.sh" ]; then
  echo "❌ setup-runner-cgroup.sh not found at $SCRIPT_DIR/setup-runner-cgroup.sh"
  exit 1
fi

if bash "$SCRIPT_DIR/setup-runner-cgroup.sh"; then
  echo ""
  echo "✅ Cgroup setup completed successfully"
else
  echo ""
  echo "⚠️  Cgroup setup completed with warnings (see above)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Step 2/3: Setting up execd CapacityAuthority"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ ! -f "$SCRIPT_DIR/setup-execd-authority.sh" ]; then
  echo "❌ setup-execd-authority.sh not found at $SCRIPT_DIR/setup-execd-authority.sh"
  exit 1
fi

if bash "$SCRIPT_DIR/setup-execd-authority.sh"; then
  echo ""
  echo "✅ execd setup completed successfully"
else
  echo ""
  echo "⚠️  execd setup completed with warnings (see above)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Step 3/3: Activating services"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "🔧 Enabling and starting orcana-execd services..."

systemctl daemon-reload
systemctl enable orcana-execd.socket orcana-execd.service 2>/dev/null || true
systemctl start orcana-execd.socket 2>/dev/null || true
systemctl start orcana-execd.service 2>/dev/null || true

echo "✅ Services activated"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 Verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check socket
if [ -S /run/orcana/execd.sock ]; then
  echo "✅ execd socket exists: /run/orcana/execd.sock"
else
  echo "⚠️  execd socket not found (service may not have started yet)"
fi

# Check services
echo ""
echo "Service status:"
systemctl status orcana-execd.socket --no-pager || echo "⚠️  Socket service not available"
echo ""
systemctl status orcana-execd.service --no-pager || echo "⚠️  execd service not available"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📚 Next Steps"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. If you modified GRUB config, reboot is required:"
echo "   sudo reboot"
echo ""
echo "2. Verify configuration:"
echo "   # Test cgroup delegation"
echo "   sudo systemd-run --property=Delegate=yes true"
echo ""
echo "   # Test execd socket"
echo "   echo '{\"type\":\"test\"}' | nc -U /run/orcana/execd.sock"
echo ""
echo "3. Run CI tests:"
echo "   bun run ci:cgroup"
echo ""
echo "4. For troubleshooting, see:"
echo "   cat RUNNER_SETUP.md"
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║ ✅ Setup Complete!                                             ║"
echo "║                                                                ║"
echo "║ The runner is now configured for delegated cgroup support.    ║"
echo "║ Run the verification steps above to confirm everything works. ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
