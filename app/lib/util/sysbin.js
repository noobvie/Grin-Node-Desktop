'use strict';
/**
 * Absolute paths of the Windows system tools this app runs.
 *
 * A bare name such as `sc.exe` is resolved through the current directory and
 * PATH, so a file of that name planted in a writable folder would run with
 * this app's (Administrator) rights. Every spawn of a system tool uses the
 * full System32 path from here instead.
 *
 * SystemRoot is set by Windows for every process; the literal fallback only
 * matters for a process started with a stripped environment.
 */

const path = require('path');

const SYSTEM32 = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

module.exports = {
    SYSTEM32,
    SC:         path.win32.join(SYSTEM32, 'sc.exe'),
    TASKKILL:   path.win32.join(SYSTEM32, 'taskkill.exe'),
    CMD:        path.win32.join(SYSTEM32, 'cmd.exe'),
    ICACLS:     path.win32.join(SYSTEM32, 'icacls.exe'),
    POWERSHELL: path.win32.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
};
