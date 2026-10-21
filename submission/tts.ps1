param([string]$Json = 'D:\code\scitag\submission\video\tts.json', [string]$OutDir = 'D:\code\scitag\submission\video')
Add-Type -AssemblyName System.Speech
$items = Get-Content $Json -Raw -Encoding UTF8 | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice('Microsoft Zira Desktop')
$synth.Rate = 0
foreach ($it in $items) {
  $path = Join-Path $OutDir ('audio-' + $it.id + '.wav')
  $synth.SetOutputToWaveFile($path)
  $synth.Speak($it.text)
  $synth.SetOutputToNull()
  Write-Output ($it.id + ' ' + $path)
}
$synth.Dispose()
