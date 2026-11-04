# Music probe: one resident child process that answers JSON lines on stdout.
# Started by src/probe/audio.ts. Plain ASCII on purpose - Windows PowerShell 5.1 reads a
# BOM-less script as ANSI, so a single non-ASCII byte would break parsing.
#
# stdin, one JSON object per line:
#   {"id":1,"cmd":"hello"}        capabilities: SMTC, loopback, elevation, ETW state
#   {"id":2,"cmd":"snapshot"}     everything below in one answer
#   {"id":3,"cmd":"reopen"}       rebuild the loopback client after an output-device change
#   {"id":4,"cmd":"stop"}         answer, then exit
#
# stdout, one JSON object per line, always with the request's "id" and "ok", non-ASCII escaped
# as \uXXXX so the console code page cannot garble a track title.
#
# JSON is assembled by hand rather than through ConvertTo-Json: Windows PowerShell 5.1 wraps an
# array in `{"value":[...],"Count":n}` there, and the audio engine already emits JSON fragments.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$script:hasSmtc = $false
$script:engineError = ''
$script:procWatchError = ''
$script:admin = $false

try {
  $script:admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

# --- output helpers -------------------------------------------------------------------------

function Esc([string]$s) {
  if ($null -eq $s) { return 'null' }
  $sb = New-Object System.Text.StringBuilder ($s.Length + 16)
  [void]$sb.Append('"')
  foreach ($ch in $s.ToCharArray()) {
    $code = [int]$ch
    if ($ch -eq '"') { [void]$sb.Append('\"') }
    elseif ($ch -eq '\') { [void]$sb.Append('\\') }
    elseif ($ch -eq "`n") { [void]$sb.Append('\n') }
    elseif ($ch -eq "`r") { [void]$sb.Append('\r') }
    elseif ($ch -eq "`t") { [void]$sb.Append('\t') }
    elseif ($code -lt 32 -or $code -gt 126) { [void]$sb.Append('\u' + $code.ToString('x4')) }
    else { [void]$sb.Append($ch) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function Send-Raw([string]$json) {
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

# --- the audio engine (WASAPI loopback + DSP + session enumeration + process starts) ---------

$engineSource = Join-Path $PSScriptRoot 'audio-engine.cs'
if (-not (Test-Path $engineSource)) {
  Send-Raw '{"id":0,"ok":false,"fatal":"audio-engine.cs is missing next to music.ps1"}'
  exit 1
}
try {
  Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $engineSource) -Language CSharp -ErrorAction Stop
} catch {
  Send-Raw ('{"id":0,"ok":false,"fatal":' + (Esc ('compile: ' + $_.Exception.Message)) + '}')
  exit 1
}

# --- SMTC (Windows.Media.Control through WinRT) ---------------------------------------------

function Initialize-Smtc {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    if ($null -eq $script:asTask) { return $false }
    return $true
  } catch {
    return $false
  }
}

function Await-Op($op, $type) {
  if ($null -eq $op) { return $null }
  $task = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

# Windows.Foundation.DateTime carries 100 ns ticks since 1601; the host needs epoch milliseconds.
function ConvertTo-UnixMs($winrtTime) {
  try {
    $raw = $winrtTime.UniversalTime
    if ($null -ne $raw -and $raw -gt 0) { return [long](($raw / 10000) - 11644473600000) }
  } catch { }
  return [long]0
}

function Get-MediaJson {
  if (-not $script:hasSmtc) { return '[]' }
  $items = New-Object System.Collections.ArrayList
  try {
    $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
    $mgr = Await-Op ($mgrType::RequestAsync()) $mgrType
    if ($null -eq $mgr) { return '[]' }
    foreach ($session in $mgr.GetSessions()) {
      $props = $null
      try {
        $propType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
        $props = Await-Op ($session.TryGetMediaPropertiesAsync()) $propType
      } catch { }

      $status = ''
      try { $status = "$($session.GetPlaybackInfo().PlaybackStatus)" } catch { }

      $position = 0.0
      $duration = 0.0
      $lastUpdated = [long]0
      try {
        $tl = $session.GetTimelineProperties()
        $position = [math]::Round($tl.Position.TotalSeconds, 2)
        $duration = [math]::Round($tl.EndTime.TotalSeconds, 2)
        $lastUpdated = ConvertTo-UnixMs $tl.LastUpdatedTime
      } catch { }

      $app = "$($session.SourceAppUserModelId)"
      $title = ''
      $artist = ''
      $album = ''
      if ($null -ne $props) {
        $title = "$($props.Title)"
        $artist = "$($props.Artist)"
        $album = "$($props.AlbumTitle)"
      }
      $row = '{"app":' + (Esc $app) + ',"title":' + (Esc $title) + ',"artist":' + (Esc $artist) +
        ',"album":' + (Esc $album) + ',"status":' + (Esc $status) +
        ',"positionSec":' + $position.ToString('0.##', [Globalization.CultureInfo]::InvariantCulture) +
        ',"durationSec":' + $duration.ToString('0.##', [Globalization.CultureInfo]::InvariantCulture) +
        ',"lastUpdatedMs":' + $lastUpdated + '}'
      [void]$items.Add($row)
    }
  } catch { }
  return '[' + ($items.ToArray() -join ',') + ']'
}

# --- process starts --------------------------------------------------------------------------

# Elevated builds read real ETW process events. Without elevation the analytic channel cannot be
# turned on, so the same fact comes from differencing process-name snapshots. Both feed the same
# "starts" array; the ticks are only present on the ETW path.
$script:seenProcs = $null

function Get-NewProcesses {
  try {
    if ([CooMusic.ProcWatch]::Active) { return [CooMusic.ProcWatch]::Drain() }
  } catch { }

  $current = @{}
  try {
    foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
      if ($null -ne $p -and $p.ProcessName) {
        $current[($p.ProcessName.ToLowerInvariant() + '.exe')] = $true
      }
    }
  } catch {
    return '[]'
  }

  if ($null -eq $script:seenProcs) {
    $script:seenProcs = $current
    return '[]'
  }

  $items = New-Object System.Collections.ArrayList
  foreach ($name in $current.Keys) {
    if (-not $script:seenProcs.ContainsKey($name)) {
      [void]$items.Add('{"name":' + (Esc $name) + ',"ticks":0}')
    }
  }
  $script:seenProcs = $current
  if ($items.Count -eq 0) { return '[]' }
  return '[' + ($items.ToArray() -join ',') + ']'
}

# --- startup ---------------------------------------------------------------------------------

$script:hasSmtc = Initialize-Smtc
$script:engineError = [CooMusic.Engine]::Start()

# The kernel process provider needs elevation. Without it the host falls back to comparing
# process snapshots, which is why a failed start is reported rather than raised.
try {
  if ($script:admin) { $script:procWatchError = [CooMusic.ProcWatch]::Start() }
  else { $script:procWatchError = 'not elevated' }
} catch {
  $script:procWatchError = $_.Exception.Message
}

# --- command loop ----------------------------------------------------------------------------

$running = $true
while ($running) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }

  $request = $null
  try { $request = ConvertFrom-Json -InputObject $line } catch {
    Send-Raw '{"id":0,"ok":false,"error":"malformed request"}'
    continue
  }

  $id = 0
  if ($null -ne $request.id) { $id = [int]$request.id }
  $cmd = "$($request.cmd)"

  try {
    if ($cmd -eq 'hello') {
      $etw = 'false'
      try { if ([CooMusic.ProcWatch]::Active) { $etw = 'true' } } catch { }
      $msg = '{"id":' + $id + ',"ok":true,"admin":' + $script:admin.ToString().ToLowerInvariant() +
        ',"smtc":' + $script:hasSmtc.ToString().ToLowerInvariant() +
        ',"etw":' + $etw +
        ',"etwError":' + (Esc $script:procWatchError) +
        ',"loopbackError":' + (Esc $script:engineError) +
        ',"powershell":' + (Esc $PSVersionTable.PSVersion.ToString()) + '}'
      Send-Raw $msg
    }
    elseif ($cmd -eq 'snapshot') {
      $audio = [CooMusic.Engine]::Snapshot()
      $sessions = [CooMusic.AudioSessions]::List()
      $starts = Get-NewProcesses
      $media = Get-MediaJson
      $at = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
      $msg = '{"id":' + $id + ',"ok":true,"at":' + $at + ',"audio":' + $audio +
        ',"sessions":' + $sessions + ',"starts":' + $starts + ',"media":' + $media + '}'
      Send-Raw $msg
    }
    elseif ($cmd -eq 'reopen') {
      $err = [CooMusic.Engine]::Reopen()
      Send-Raw ('{"id":' + $id + ',"ok":true,"error":' + (Esc $err) + '}')
    }
    elseif ($cmd -eq 'stop') {
      Send-Raw ('{"id":' + $id + ',"ok":true}')
      $running = $false
    }
    else {
      Send-Raw ('{"id":' + $id + ',"ok":false,"error":' + (Esc ('unknown cmd: ' + $cmd)) + '}')
    }
  } catch {
    Send-Raw ('{"id":' + $id + ',"ok":false,"error":' + (Esc $_.Exception.Message) + '}')
  }
}

try { [CooMusic.Engine]::Stop() } catch { }
try { [CooMusic.ProcWatch]::Stop() } catch { }
