param(
    [string]$SourcePath = (Join-Path $PSScriptRoot 'assets\app-icon-source.png')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$assets = Join-Path $PSScriptRoot 'assets'
New-Item -ItemType Directory -Path $assets -Force | Out-Null
$source = [System.Drawing.Bitmap]::new($SourcePath)
try {
    $minX = $source.Width
    $minY = $source.Height
    $maxX = -1
    $maxY = -1
    for ($y = 0; $y -lt $source.Height; $y++) {
        for ($x = 0; $x -lt $source.Width; $x++) {
            if ($source.GetPixel($x, $y).A -le 8) { continue }
            $minX = [Math]::Min($minX, $x)
            $minY = [Math]::Min($minY, $y)
            $maxX = [Math]::Max($maxX, $x)
            $maxY = [Math]::Max($maxY, $y)
        }
    }
    if ($maxX -lt 0) { throw '图标图片没有可见像素。' }

    $width = $maxX - $minX + 1
    $height = $maxY - $minY + 1
    $side = [Math]::Max($width, $height)
    $padding = [Math]::Ceiling($side * 0.04)
    $cropSide = $side + 2 * $padding
    $cropX = $minX - [Math]::Floor(($side - $width) / 2) - $padding
    $cropY = $minY - [Math]::Floor(($side - $height) / 2) - $padding
    $crop = [System.Drawing.Rectangle]::new($cropX, $cropY, $cropSide, $cropSide)

    $sizes = @(16, 24, 32, 48, 64, 128, 256)
    $images = @()
    foreach ($size in $sizes) {
        $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.Clear([System.Drawing.Color]::Transparent)
                $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
                $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $graphics.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, $size, $size), $crop, [System.Drawing.GraphicsUnit]::Pixel)
            } finally { $graphics.Dispose() }

            if ($size -eq 256) {
                $bitmap.Save((Join-Path $assets 'app-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
            }
            $stream = [System.IO.MemoryStream]::new()
            try {
                $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                $images += ,$stream.ToArray()
            } finally { $stream.Dispose() }
        } finally { $bitmap.Dispose() }
    }

    $path = Join-Path $assets 'app-icon.ico'
    $file = [System.IO.File]::Create($path)
    try {
        $writer = [System.IO.BinaryWriter]::new($file)
        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]$sizes.Count)
        $offset = 6 + 16 * $sizes.Count
        for ($i = 0; $i -lt $sizes.Count; $i++) {
            $encodedSize = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
            $writer.Write([byte]$encodedSize)
            $writer.Write([byte]$encodedSize)
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([UInt16]1)
            $writer.Write([UInt16]32)
            $writer.Write([UInt32]$images[$i].Length)
            $writer.Write([UInt32]$offset)
            $offset += $images[$i].Length
        }
        foreach ($bytes in $images) { $writer.Write([byte[]]$bytes) }
        $writer.Flush()
    } finally { $file.Dispose() }
    Write-Output $path
} finally { $source.Dispose() }
