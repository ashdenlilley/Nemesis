import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

// Saves the clipboard image as a PNG in dir and returns its path, or null when the clipboard holds no image
// or no clipboard tool is available. Windows: PowerShell + System.Windows.Forms. macOS: pngpaste (brew).
// Linux: xclip. Nothing is installed; a missing tool just means null.
export async function clipboardImage(dir, { platform = process.platform, run = runOk } = {}) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `clip-${Date.now()}.png`);
  let ok = false;
  if (platform === 'win32') {
    const quoted = file.replace(/'/g, "''");
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$i = [System.Windows.Forms.Clipboard]::GetImage()',
      'if ($i -eq $null) { exit 3 }',
      `$i.Save('${quoted}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    ].join('; ');
    ok = await run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script]);
  } else if (platform === 'darwin') {
    ok = await run('pngpaste', [file]);
  } else {
    ok = await run('sh', ['-c', `xclip -selection clipboard -t image/png -o > '${file.replace(/'/g, "'\\''")}'`]);
  }
  if (!ok) return null;
  const info = await stat(file).catch(() => null);
  return info?.size ? file : null;
}

function runOk(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, (err) => resolve(!err));
  });
}
