param([string]$file)

$path = [string]$file
$fs = New-Object System.IO.FileStream($path, "Open")
$len = $fs.Length
$bytes = New-Object byte[] ($len)
$fs.Read($bytes, 0, $len)
$fs.Close()

# Build a latin-1 string of all bytes for fast native search
$s = New-Object System.String($bytes, "ISO-8859-1")

# ICO container header: 00 00 01 00 00
$p1 = chr(0) + chr(0) + chr(1) + chr(0) + chr(0)
$idxIco = $s.IndexOf($p1)

# PNG signature inside ico (icon image stored as PNG): 89 50 4E 47
$p2 = chr(0x89) + "PNG"
$idxPng = $s.IndexOf($p2)

Write-Output ("file size        = " + $len)
Write-Output ("ICONDIR header at byte " + $idxIco)
Write-Output ("embedded PNG blobs at byte " + $idxPng)