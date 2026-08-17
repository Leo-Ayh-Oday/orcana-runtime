# Self-Hosted Runner Setup Guide

This guide explains how to configure your GitHub Actions self-hosted runner to support Orcana's delegated cgroup and execd CapacityAuthority requirements.

## Overview

The Orcana runtime requires two key Linux features for the sandbox execution eval tests:

1. **Delegated cgroup v2** - for resource isolation and task execution
2. **execd CapacityAuthority socket** - for production execution authority and evidence collection

This guide walks through setting up both.

## Prerequisites

- Ubuntu 20.04+ (or similar systemd-based Linux distribution)
- Root or sudo access on the runner host
- GitHub Actions self-hosted runner already installed
- Bun 1.3.14+ and Node.js 22+ (usually already installed by runner)

## Step 1: System-Level cgroup v2 Configuration

### Check Current cgroup Version

```bash
# Check if cgroup v2 is available
cat /proc/cgroups | grep cgroup2

# Check if systemd is using cgroup v2
systemctl status | grep "control group version"
```

### Enable cgroup v2 (if needed)

If cgroup v2 is not available, add the kernel boot parameter:

```bash
# For Ubuntu/Debian
sudo nano /etc/default/grub
```

Find the line:
```
GRUB_CMDLINE_LINUX=""
```

Add the parameter:
```
GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1"
```

Update GRUB and reboot:
```bash
sudo update-grub
sudo reboot
```

After reboot, verify:
```bash
cat /proc/cgroups | grep cgroup2
```

## Step 2: Run Automated Setup Scripts

### A. Set up Cgroup Delegation

```bash
cd /path/to/orcana-runtime
sudo bash scripts/ci/setup-runner-cgroup.sh
```

This script will:
- ✅ Install systemd if missing
- ✅ Enable cgroup v2 (if needed)
- ✅ Configure user lingering for the runner user
- ✅ Create `/run/orcana` with proper permissions
- ✅ Verify delegation capability

### B. Set up execd CapacityAuthority

```bash
sudo bash scripts/ci/setup-execd-authority.sh
```

This script will:
- ✅ Create systemd service template for execd
- ✅ Create systemd socket unit
- ✅ Create mock execd authority binary
- ✅ Configure sudoers rules for the runner
- ✅ Set up proper directory permissions

## Step 3: Activate Services

```bash
# Enable socket-based activation
sudo systemctl enable orcana-execd.socket
sudo systemctl start orcana-execd.socket

# Enable service
sudo systemctl enable orcana-execd.service
sudo systemctl start orcana-execd.service
```

Verify services are running:

```bash
sudo systemctl status orcana-execd.socket
sudo systemctl status orcana-execd.service

# Check socket file exists
ls -la /run/orcana/execd.sock
```

## Step 4: Verify Configuration

### Test cgroup Delegation

```bash
# Test user-mode delegation
systemd-run --user --property=Delegate=yes true

# Test system-wide delegation (with sudo)
sudo systemd-run --property=Delegate=yes true
```

Expected output: Command exits with status 0

### Test execd Socket

```bash
# Check socket is accessible
file /run/orcana/execd.sock

# Test socket connection
echo '{"type":"capacity"}' | nc -U /run/orcana/execd.sock

# You should see a JSON response like:
# {"success":true,"timestamp":"...","capacity":{"available":true,...}}
```

### Run CI Tests

```bash
cd /path/to/orcana-runtime

# Run just the cgroup tests
bun run ci:cgroup

# Or run full Linux eval suite
bun run eval:linux --require=cgroup
```

Expected output: Tests pass with "LX-036 Receipt → Evidence → Completion Gate" test succeeding.

## Step 5: Troubleshooting

### Issue: "systemd-run: command not found"

```bash
# Install systemd
sudo apt-get update
sudo apt-get install -y systemd
```

### Issue: "Delegate=yes not supported"

This usually means cgroup v2 is not enabled:

```bash
# Verify cgroup v2
stat /sys/fs/cgroup/cgroup.controllers

# If not found, follow "Enable cgroup v2" steps above and reboot
```

### Issue: execd socket not found

Check if service is running:

```bash
sudo systemctl status orcana-execd.service

# View logs
sudo journalctl -u orcana-execd.service -n 50

# Manually start if stopped
sudo systemctl start orcana-execd.service
```

### Issue: Permission denied on socket

```bash
# Check permissions
ls -la /run/orcana/

# Should show:
# drwxr-xr-x github-actions github-actions /run/orcana
# srw-rw---- github-actions github-actions /run/orcana/execd.sock
```

If permissions are wrong, restart service:

```bash
sudo systemctl restart orcana-execd.socket
sudo systemctl restart orcana-execd.service
```

### Issue: Tests still fail with RESOURCE_AUTHORITY_UNAVAILABLE

1. Verify socket exists and is accessible:
   ```bash
   test -S /run/orcana/execd.sock && echo "Socket exists" || echo "Socket missing"
   ```

2. Check runner user can access socket:
   ```bash
   sudo -u github-actions test -w /run/orcana/execd.sock && echo "Writable" || echo "Not writable"
   ```

3. Check systemd logs:
   ```bash
   sudo journalctl -u orcana-execd.socket -u orcana-execd.service -n 100
   ```

4. Manually test socket connection as runner user:
   ```bash
   sudo -u github-actions bash -c 'echo "{\"type\":\"test\"}" | nc -U /run/orcana/execd.sock'
   ```

## Step 6: CI Configuration (Optional)

The CI workflow is already configured to use these features. If you want to customize:

1. Edit `.github/workflows/ci.yml`
2. The `eval-linux` job uses `scripts/ci/run-delegated-cgroup.sh` which:
   - Detects passwordless sudo availability
   - Falls back to user-mode systemd
   - Provides delegated cgroup namespace

## Advanced: Custom execd Authority

The setup creates a mock execd authority. For production use with real execution authority:

1. Replace `/opt/orcana/bin/execd-authority.js` with your actual implementation
2. Update `/etc/systemd/system/orcana-execd.service` ExecStart if needed
3. Ensure your implementation:
   - Listens on Unix domain socket `/run/orcana/execd.sock`
   - Responds to capacity queries
   - Supports graceful shutdown via SIGTERM

Example protocol:
```json
// Request
{"type":"capacity","features":["cgroup_v2","namespaces"]}

// Response
{"success":true,"capacity":{"available":true,"cgroup_v2":true,"namespaces":true}}
```

## Monitoring

Check service health regularly:

```bash
# View service logs
sudo journalctl -u orcana-execd.service -f

# Check resource usage
systemctl status orcana-execd.service

# Monitor socket connection count
watch 'lsof +D /run/orcana/ 2>/dev/null || echo "lsof not available"'
```

## Additional Resources

- [systemd cgroup delegation](https://systemd.io/CGROUP_DELEGATION/)
- [Linux cgroup v2 documentation](https://kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
- [Orcana Runtime Documentation](../README.md)

## Support

If issues persist:

1. Collect diagnostics:
   ```bash
   bash -x scripts/ci/setup-runner-cgroup.sh 2>&1 | tee setup-cgroup.log
   bash -x scripts/ci/setup-execd-authority.sh 2>&1 | tee setup-execd.log
   sudo journalctl -u orcana-execd.service -n 200 > execd-logs.txt
   ```

2. Create an issue with these logs attached
