# SciTag launcher: open the running instance if any, otherwise start a demo server and open the browser.
$ErrorActionPreference = 'SilentlyContinue'
$ports = @(8790, 8093)
foreach ($p in $ports) {
    $client = New-Object System.Net.Sockets.TcpClient
    $ok = $false
    try { $ok = $client.ConnectAsync('127.0.0.1', $p).Wait(400) } catch {}
    finally { $client.Close() }
    if ($ok) { Start-Process ("http://127.0.0.1:" + $p); exit 0 }
}
$root = 'D:\code\scitag'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', "cd /d $root && set SCITAG_PORT=8093 && node server.js" -WorkingDirectory $root
Start-Sleep -Seconds 3
Start-Process 'http://127.0.0.1:8093'
