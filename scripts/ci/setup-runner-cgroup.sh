#!/usr/bin/env bash
set -euo pipefail

# Setup script for GitHub Actions self-hosted runner to enable delegated cgroup support
# Run this once on the runner host as root or with sudo
# Usage: sudo bash scripts/ci/setup-runner-cgroup.sh

echo "=== Orcana CI Runner Cgroup Setup ==="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "❌ This script must be run as root (use: sudo bash scripts/ci/setup-runner-cgroup.sh)"
  exit 1
fi

# Detect Linux distribution
if [ -f /etc/os-release ]; then
  . /etc/os-release
  DISTRO="$ID"
else
  echo "❌ Cannot detect Linux distribution"
  exit 1
fi

echo "📦 Detected distribution: $DISTRO"
echo ""

# Install systemd if not present
if ! command -v systemd-run &> /dev/null; then
  echo "📥 Installing systemd..."
  case "$DISTRO" in
    ubuntu|debian)
      apt-get update
      apt-get install -y systemd
      ;;
    fedora|rhel|centos)
      yum install -y systemd
      ;;
    *)
      echo "⚠️  Unknown distribution, skipping systemd install. Please install manually."
      ;;
  esac
else
  echo "✅ systemd-run already installed"
fi

echo ""
echo "🔧 Configuring cgroup v2 delegation..."
echo ""

# Enable cgroup v2 if not already enabled
if [ -f /etc/default/grub ]; then
  if ! grep -q "systemd.unified_cgroup_hierarchy=1" /etc/default/grub; then
    echo "  Adding systemd.unified_cgroup_hierarchy=1 to GRUB config..."
    sed -i 's/GRUB_CMDLINE_LINUX="/GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1 /' /etc/default/grub
    update-grub 2>/dev/null || grub2-mkconfig -o /boot/grub2/grub.cfg 2>/dev/null || true
    echo "  ⚠️  GRUB updated - reboot required for changes to take effect"
    REBOOT_REQUIRED=1
  fi
fi

# Check current cgroup version
if [ -f /proc/cgroups ]; then
  if grep -q "cgroup2" /proc/cgroups; then
    echo "✅ cgroup v2 is available"
  else
    echo "⚠️  cgroup v2 not detected. May need to enable in kernel or reboot."
  fi
fi

echo ""
echo "🔐 Setting up systemd user session delegation..."
echo ""

# Enable user lingering for github-actions user if it exists
if id -u github-actions &>/dev/null 2>&1; then
  echo "  Enabling lingering for github-actions user..."
  mkdir -p /var/lib/systemd/linger
  touch /var/lib/systemd/linger/github-actions
  echo "  ✅ User lingering enabled"
else
  echo "  ⚠️  github-actions user not found. If using different user, run:"
  echo "     sudo mkdir -p /var/lib/systemd/linger && sudo touch /var/lib/systemd/linger/<username>"
fi

echo ""
echo "📁 Creating orcana runtime directory..."
mkdir -p /run/orcana
chmod 755 /run/orcana

if id -u github-actions &>/dev/null 2>&1; then
  chown github-actions:github-actions /run/orcana
  chmod 755 /run/orcana
  echo "  ✅ /run/orcana directory configured"
fi

echo ""
echo "🔍 Verifying cgroup delegation..."
echo ""

# Test systemd-run with delegation
if sudo -u github-actions systemd-run --user --property=Delegate=yes true 2>/dev/null; then
  echo "✅ Delegated cgroup (--user mode) is working"
else
  echo "⚠️  User-mode delegation test failed"
  echo "   This may be normal if user session is not active yet"
fi

# Test passwordless sudo for system-wide delegation
if sudo -n true &>/dev/null 2>&1; then
  echo "✅ Passwordless sudo is available (for system-wide delegation)"
else
  echo "⚠️  Passwordless sudo not configured"
  echo "   GitHub Actions runners should have this by default"
fi

echo ""
echo "=== Configuration Complete ==="
echo ""
echo "Next steps:"
echo "1. If you modified GRUB config, reboot the system: sudo reboot"
echo "2. Verify cgroup delegation: bun run ci:cgroup"
echo "3. If tests still fail, check:"
echo "   - systemctl status"
echo "   - cat /proc/cgroups"
echo "   - loginctl show-user \$(whoami)"
echo ""
