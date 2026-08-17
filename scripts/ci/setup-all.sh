#!/usr/bin/env bash
# Quick start script for setting up Orcana CI on self-hosted runner
# Usage: sudo bash scripts/ci/setup-all.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Orcana Runtime CI Setup - Complete Configuration          ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Check root
if [ "$EUID" -ne 0 ]; then
  echo "❌ This script must be run as root"
  echo "   Usage: sudo bash $0"
  exit 1
fi

# Step 1: cgroup setup
echo "📦 Step 1/3: Setting up cgroup v2 delegation..."
echo ""
if bash "$SCRIPT_DIR/setup-runner-cgroup.sh"; then
  echo ""
  echo "✅ Step 1 complete: cgroup v2 delegation configured"
else
  echo "⚠️  Step 1 had issues, but continuing..."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Step 2: execd setup
echo "⚙️  Step 2/3: Setting up execd CapacityAuthority..."
echo ""
if bash "$SCRIPT_DIR/setup-execd-authority.sh"; then
  echo ""
  echo "✅ Step 2 complete: execd CapacityAuthority configured"
else
  echo "⚠️  Step 2 had issues, but continuing..."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Step 3: Verification
echo "✅ Step 3/3: Verifying configuration..."
echo ""

ERRORS=0

# Check cgroup v2
if grep -q cgroup2 /proc/cgroups 2>/dev/null; then
  echo "  ✅ cgroup v2 is available"
else
  echo "  ⚠️  cgroup v2 not detected (may need reboot)"
  ((ERRORS++))
fi

# Check systemd-run
if command -v systemd-run &>/dev/null; then
  echo "  ✅ systemd-run is available"
else
  echo "  ❌ systemd-run not found"
  ((ERRORS++))
fi

# Check execd socket
if [ -S /run/orcana/execd.sock ]; then
  echo "  ✅ execd socket exists at /run/orcana/execd.sock"
else
  echo "  ⚠️  execd socket not found (may need to start service)"
  ((ERRORS++))
fi

# Check service status
if systemctl is-active --quiet orcana-execd.service; then
  echo "  ✅ orcana-execd.service is running"
else
  echo "  ⚠️  orcana-execd.service is not running"
  echo "     Start with: sudo systemctl start orcana-execd.service"
  ((ERRORS++))
fi

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Setup Complete!                                           ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

if [ $ERRORS -eq 0 ]; then
  echo "✅ All checks passed! Your runner is ready for Orcana CI."
  echo ""
  echo "Next steps:"
  echo "  1. cd $REPO_ROOT"
  echo "  2. bun run ci:cgroup          # Run quick verification"
  echo "  3. bun run eval:linux         # Run full eval suite"
  echo ""
  exit 0
else
  echo "⚠️  $ERRORS issue(s) found. Review above and:"
  echo ""
  echo "Common fixes:"
  echo "  - If cgroup v2 missing: Add 'systemd.unified_cgroup_hierarchy=1' to GRUB and reboot"
  echo "  - If systemd-run missing: sudo apt-get install -y systemd"
  echo "  - If socket missing: sudo systemctl restart orcana-execd.socket"
  echo ""
  echo "See RUNNER_SETUP.md for troubleshooting"
  exit 1
fi
