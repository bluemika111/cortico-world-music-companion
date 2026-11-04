// Audio engine behind scripts/music.ps1. Plain ASCII: Windows PowerShell 5.1 reads a BOM-less
// script as ANSI, so a stray non-ASCII byte would break parsing.
//
// Three things live here, all reachable from PowerShell as static members:
//   Engine    - WASAPI loopback capture on the default render endpoint, reduced to a sliding
//               window of loudness / band / rhythm features (no audio ever leaves this process)
//   AudioSessions - which processes hold an audio session right now, and in what state
//   ProcWatch - process starts: a real ETW subscription when the caller is elevated, otherwise
//               nothing (music.ps1 falls back to snapshot differencing)
//
// Compiled once at startup by Add-Type. Nothing here touches the network or the disk.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CooMusic
{
    #region Core Audio interop

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    internal struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    internal struct WAVEFORMATEXTENSIBLE
    {
        public WAVEFORMATEX Format;
        public ushort wValidBitsPerSample;
        public uint dwChannelMask;
        public Guid SubFormat;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        int NotImplEnumAudioEndpoints();
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity,
            IntPtr pFormat, IntPtr audioSessionGuid);
        int GetBufferSize(out uint bufferFrames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint padding);
        int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr closestMatchFormat);
        int GetMixFormat(out IntPtr deviceFormat);
        int GetDevicePeriod(out long defaultDevicePeriod, out long minimumDevicePeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr eventHandle);
        int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out uint pdwFlags,
            out ulong pu64DevicePosition, out ulong pu64QPCPosition);
        int ReleaseBuffer(uint numFramesRead);
        int GetNextPacketSize(out uint pNumFramesInNextPacket);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionEnumerator
    {
        int GetCount(out int sessionCount);
        int GetSession(int sessionIndex, out IAudioSessionControl session);
    }

    [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl
    {
        int GetState(out int state);
        int GetDisplayName(out IntPtr name);
        int SetDisplayName(IntPtr name, IntPtr eventContext);
        int GetIconPath(out IntPtr path);
        int SetIconPath(IntPtr path, IntPtr eventContext);
        int GetGroupingParam(out Guid groupingId);
        int SetGroupingParam(ref Guid groupingId, IntPtr eventContext);
        int RegisterAudioSessionNotification(IntPtr client);
        int UnregisterAudioSessionNotification(IntPtr client);
    }

    [ComImport, Guid("BFA971F1-4D5E-40BB-935E-967039BFBEE4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl2
    {
        int GetState(out int state);
        int GetDisplayName(out IntPtr name);
        int SetDisplayName(IntPtr name, IntPtr eventContext);
        int GetIconPath(out IntPtr path);
        int SetIconPath(IntPtr path, IntPtr eventContext);
        int GetGroupingParam(out Guid groupingId);
        int SetGroupingParam(ref Guid groupingId, IntPtr eventContext);
        int RegisterAudioSessionNotification(IntPtr client);
        int UnregisterAudioSessionNotification(IntPtr client);
        int GetSessionIdentifier(out IntPtr retVal);
        int GetSessionInstanceIdentifier(out IntPtr retVal);
        int GetProcessId(out uint retVal);
        int IsSystemSoundsSession();
        int SetDuckingPreference(bool optOut);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionManager2
    {
        int GetAudioSessionControl(ref Guid audioSessionGuid, uint streamFlags, out IAudioSessionControl sessionControl);
        int GetSimpleAudioVolume(ref Guid audioSessionGuid, uint streamFlags, out IntPtr audioVolume);
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
        int RegisterSessionNotification(IntPtr sessionNotification);
        int UnregisterSessionNotification(IntPtr sessionNotification);
        int RegisterDuckNotification(IntPtr sessionNotification);
        int UnregisterDuckNotification(IntPtr sessionNotification);
    }

    #endregion

    /** Second-order Butterworth section. Two in cascade are close enough to a band split. */
    internal sealed class Biquad
    {
        double b0, b1, b2, a1, a2, x1, x2, y1, y2;

        public static Biquad LowPass(double fs, double f0)
        {
            double w0 = 2 * Math.PI * f0 / fs;
            double cw = Math.Cos(w0), sw = Math.Sin(w0);
            double alpha = sw / (2 * 0.70710678);
            double a0 = 1 + alpha;
            var q = new Biquad();
            q.b0 = ((1 - cw) / 2) / a0;
            q.b1 = (1 - cw) / a0;
            q.b2 = ((1 - cw) / 2) / a0;
            q.a1 = (-2 * cw) / a0;
            q.a2 = (1 - alpha) / a0;
            return q;
        }

        public double Process(double x)
        {
            double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1; x1 = x; y2 = y1; y1 = y;
            return y;
        }

        public void Reset() { x1 = x2 = y1 = y2 = 0; }
    }

    /** One 100 ms feature frame. Bands are RMS of low / mid / high, all linear. */
    internal struct Frame
    {
        public double Rms, Peak, Low, Mid, High, Zcr;
    }

    public static class Engine
    {
        const int eRender = 0;
        const int eMultimedia = 1;
        const int CLSCTX_ALL = 23;
        const int SHARED = 0;
        const int LOOPBACK = 0x00020000;
        const int BUFFERFLAGS_SILENT = 0x2;

        const int FrameMs = 100;
        const int SubMs = 10;
        const int WindowSeconds = 12;
        const int MaxFrames = WindowSeconds * 1000 / FrameMs;
        const int MaxSubs = WindowSeconds * 1000 / SubMs;

        [DllImport("ole32.dll")]
        static extern int CoTaskMemFree(IntPtr p);

        /** Monotonic milliseconds. Environment.TickCount64 is not on the .NET 4.x profile Add-Type targets. */
        static long NowMs()
        {
            return (long)(Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency);
        }

        static readonly object gate = new object();
        static volatile bool running;
        static Thread worker;

        static string deviceName = "";
        static int sampleRate, channels, bits;
        static bool isFloat, isPcm16;
        static long totalFrames, packetsRead;
        static long lastPacketTick;      // NowMs(), 0 = never
        static long startTick;
        static string lastError = "";
        static int reopenCount;

        // Sliding window, oldest first.
        static readonly List<Frame> frames = new List<Frame>(MaxFrames + 8);
        static readonly List<double> subEnergy = new List<double>(MaxSubs + 8);

        // Accumulators for the frame / sub-frame in progress.
        static double curSq, curPeak, curLowSq, curMidSq, curHighSq;
        static int curCrossings, curN;
        static double subSq; static int subN;
        static Biquad lpLow, lpMid;
        static bool prevPositive;

        static int frameSize = 4800, subSize = 480;

        public static string Start()
        {
            lock (gate)
            {
                if (running) return "";
                running = true;
                lastError = "";
                startTick = NowMs();
                worker = new Thread(CaptureLoop) { IsBackground = true, Name = "coo-music-loopback" };
                worker.Start();
            }
            Thread.Sleep(150);
            lock (gate) return lastError;
        }

        public static void Stop()
        {
            lock (gate) running = false;
            var w = worker;
            worker = null;
            if (w != null) w.Join(1500);
        }

        /** Re-open the endpoint, for when the default output device changed under us. */
        public static string Reopen()
        {
            Stop();
            lock (gate)
            {
                frames.Clear(); subEnergy.Clear();
                packetsRead = 0; totalFrames = 0; lastPacketTick = 0;
                reopenCount++;
            }
            return Start();
        }

        static void CaptureLoop()
        {
            IAudioClient client = null;
            IAudioCaptureClient capture = null;
            try
            {
                IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
                IMMDevice device;
                int hr = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia, out device);
                if (hr != 0) { Fail("endpoint 0x" + hr.ToString("X8")); return; }

                Guid iidClient = typeof(IAudioClient).GUID;
                object clientObj;
                hr = device.Activate(ref iidClient, CLSCTX_ALL, IntPtr.Zero, out clientObj);
                if (hr != 0) { Fail("activate 0x" + hr.ToString("X8")); return; }
                client = (IAudioClient)clientObj;

                IntPtr pFormat;
                hr = client.GetMixFormat(out pFormat);
                if (hr != 0) { Fail("mixformat 0x" + hr.ToString("X8")); return; }

                WAVEFORMATEX fmt = (WAVEFORMATEX)Marshal.PtrToStructure(pFormat, typeof(WAVEFORMATEX));
                string subFormat = "";
                if (fmt.wFormatTag == 0xFFFE)
                {
                    WAVEFORMATEXTENSIBLE ext = (WAVEFORMATEXTENSIBLE)Marshal.PtrToStructure(pFormat, typeof(WAVEFORMATEXTENSIBLE));
                    subFormat = ext.SubFormat.ToString();
                }
                bool f = fmt.wFormatTag == 3 || (fmt.wFormatTag == 0xFFFE && subFormat.StartsWith("00000003"));
                bool p16 = fmt.wFormatTag == 1 || (fmt.wFormatTag == 0xFFFE && subFormat.StartsWith("00000001"));

                hr = client.Initialize(SHARED, LOOPBACK, 2000000, 0, pFormat, IntPtr.Zero);
                CoTaskMemFree(pFormat);
                if (hr != 0) { Fail("init 0x" + hr.ToString("X8")); return; }

                Guid iidCap = typeof(IAudioCaptureClient).GUID;
                object capObj;
                hr = client.GetService(ref iidCap, out capObj);
                if (hr != 0) { Fail("service 0x" + hr.ToString("X8")); return; }
                capture = (IAudioCaptureClient)capObj;

                hr = client.Start();
                if (hr != 0) { Fail("start 0x" + hr.ToString("X8")); return; }

                lock (gate)
                {
                    deviceName = "default render endpoint";
                    sampleRate = (int)fmt.nSamplesPerSec;
                    channels = fmt.nChannels;
                    bits = fmt.wBitsPerSample;
                    isFloat = f; isPcm16 = p16;
                    frameSize = Math.Max(1, sampleRate * FrameMs / 1000);
                    subSize = Math.Max(1, sampleRate * SubMs / 1000);
                    lpLow = Biquad.LowPass(sampleRate, 250);
                    lpMid = Biquad.LowPass(sampleRate, 4000);
                    prevPositive = false;
                    lastError = "";
                    lastPacketTick = NowMs();
                }

                // Formats we cannot read still produce a loudness number from the raw bytes being
                // present, but a wrong decode would report noise. Say so instead of guessing.
                if (!f && !p16) { Fail("unsupported format tag=" + fmt.wFormatTag + " bits=" + fmt.wBitsPerSample); return; }

                while (running)
                {
                    bool sawAny = false;
                    uint packet;
                    while (capture.GetNextPacketSize(out packet) == 0 && packet > 0)
                    {
                        IntPtr data; uint frameCount; uint flags; ulong devPos; ulong qpc;
                        if (capture.GetBuffer(out data, out frameCount, out flags, out devPos, out qpc) != 0) { break; }
                        sawAny = true;
                        if (frameCount > 0)
                        {
                            lock (gate)
                            {
                                lastPacketTick = NowMs();
                                packetsRead++;
                                totalFrames += frameCount;
                                if ((flags & BUFFERFLAGS_SILENT) != 0) FeedSilence((int)frameCount);
                                else Feed(data, (int)frameCount);
                            }
                        }
                        capture.ReleaseBuffer(frameCount);
                    }
                    // 15 ms when audio flows, so a device the app switched away from is noticed;
                    // longer when idle so a paused player costs almost nothing.
                    Thread.Sleep(sawAny ? 15 : 200);
                }
            }
            catch (Exception ex)
            {
                Fail(ex.GetType().Name + ": " + ex.Message);
            }
            finally
            {
                try { if (client != null) client.Stop(); } catch { }
                if (capture != null) Marshal.ReleaseComObject(capture);
                if (client != null) Marshal.ReleaseComObject(client);
                lock (gate) running = false;
            }
        }

        static void Fail(string message)
        {
            lock (gate) { lastError = message; running = false; }
        }

        static void FeedSilence(int frames)
        {
            for (int i = 0; i < frames; i++) Accumulate(0);
        }

        static void Feed(IntPtr data, int frameCount)
        {
            int n = frameCount * channels;
            if (isFloat && bits == 32)
            {
                var buf = new float[n];
                Marshal.Copy(data, buf, 0, n);
                for (int i = 0; i < frameCount; i++)
                {
                    double mono = 0;
                    for (int c = 0; c < channels; c++) mono += buf[i * channels + c];
                    Accumulate(mono / channels);
                }
            }
            else // PCM16
            {
                var buf = new short[n];
                Marshal.Copy(data, buf, 0, n);
                for (int i = 0; i < frameCount; i++)
                {
                    double mono = 0;
                    for (int c = 0; c < channels; c++) mono += buf[i * channels + c] / 32768.0;
                    Accumulate(mono / channels);
                }
            }
        }

        static void Accumulate(double s)
        {
            double a = s < 0 ? -s : s;
            curSq += s * s;
            if (a > curPeak) curPeak = a;
            subSq += s * s;
            double low = lpLow.Process(s);
            double lowMid = lpMid.Process(s);
            double mid = lowMid - low;
            double high = s - lowMid;
            curLowSq += low * low;
            curMidSq += mid * mid;
            curHighSq += high * high;
            bool positive = s >= 0;
            if (positive != prevPositive) { curCrossings++; prevPositive = positive; }
            curN++;

            if (++subN >= subSize)
            {
                subEnergy.Add(Math.Sqrt(subSq / subN));
                subSq = 0; subN = 0;
                if (subEnergy.Count > MaxSubs) subEnergy.RemoveRange(0, subEnergy.Count - MaxSubs);
            }
            if (curN >= frameSize)
            {
                var f = new Frame();
                f.Rms = Math.Sqrt(curSq / curN);
                f.Peak = curPeak;
                f.Low = Math.Sqrt(curLowSq / curN);
                f.Mid = Math.Sqrt(curMidSq / curN);
                f.High = Math.Sqrt(curHighSq / curN);
                f.Zcr = (double)curCrossings / curN;
                frames.Add(f);
                if (frames.Count > MaxFrames) frames.RemoveRange(0, frames.Count - MaxFrames);
                curSq = curPeak = curLowSq = curMidSq = curHighSq = 0;
                curCrossings = 0; curN = 0;
            }
        }

        static double Db(double linear)
        {
            if (linear <= 1e-7) return -120.0;
            return 20.0 * Math.Log10(linear);
        }

        static double Percentile(List<double> sorted, double p)
        {
            if (sorted.Count == 0) return 0;
            int i = (int)Math.Round((sorted.Count - 1) * p);
            if (i < 0) i = 0;
            if (i >= sorted.Count) i = sorted.Count - 1;
            return sorted[i];
        }

        /** Strongest autocorrelation peak of the 10 ms energy envelope, in the 48-240 BPM band. */
        static double EstimateBpm(out double strength)
        {
            strength = 0;
            int n = subEnergy.Count;
            if (n < 200) return 0;

            // Count attacks first. A tempo needs transients; sustained sound has none, and its
            // autocorrelation peaks at arbitrary lags.
            double maxRise = 0;
            for (int i = 1; i < n; i++)
            {
                double rise = subEnergy[i] - subEnergy[i - 1];
                if (rise > maxRise) maxRise = rise;
            }
            if (maxRise <= 1e-6) return 0;
            int onsets = 0;
            for (int i = 1; i < n; i++)
            {
                if (subEnergy[i] - subEnergy[i - 1] > maxRise * 0.25) onsets++;
            }
            if (onsets < 4) return 0;

            var e = new double[n];
            double mean = 0;
            for (int i = 0; i < n; i++) { e[i] = subEnergy[i]; mean += e[i]; }
            mean /= n;
            double variance = 0;
            for (int i = 0; i < n; i++) { e[i] -= mean; variance += e[i] * e[i]; }
            variance /= n;
            if (variance < 1e-9) return 0;
            // A steady tone has a flat envelope, and a flat envelope correlates with itself at
            // every lag; only sound that actually rises and falls can have a tempo.
            if (Math.Sqrt(variance) / (mean + 1e-9) < 0.02) return 0;

            int minLag = 25, maxLag = 125;   // 0.25 s .. 1.25 s
            if (maxLag >= n / 2) maxLag = n / 2 - 1;
            if (maxLag <= minLag) return 0;

            int bestLag = 0;
            double best = 0;
            for (int lag = minLag; lag <= maxLag; lag++)
            {
                double sum = 0;
                for (int i = 0; i + lag < n; i++) sum += e[i] * e[i + lag];
                sum /= (n - lag);
                if (sum > best) { best = sum; bestLag = lag; }
            }
            if (bestLag == 0) return 0;
            strength = best / variance;
            double bpm = 60000.0 / (bestLag * SubMs);
            // Fold into the range people actually tap along to, so a strong half-tempo peak
            // reports 120 rather than 60.
            while (bpm < 70) bpm *= 2;
            while (bpm > 160) bpm /= 2;
            return bpm;
        }

        /** JSON summary of the last 12 s. Caller-visible; never contains samples. */
        public static string Snapshot()
        {
            lock (gate)
            {
                long now = NowMs();
                double staleMs = lastPacketTick == 0 ? -1 : now - lastPacketTick;

                var dbList = new List<double>(frames.Count);
                double sqSum = 0, peak = 0, low = 0, mid = 0, high = 0, zcr = 0;
                for (int i = 0; i < frames.Count; i++)
                {
                    Frame f = frames[i];
                    sqSum += f.Rms * f.Rms;
                    if (f.Peak > peak) peak = f.Peak;
                    low += f.Low * f.Low; mid += f.Mid * f.Mid; high += f.High * f.High;
                    zcr += f.Zcr;
                    dbList.Add(Db(f.Rms));
                }
                dbList.Sort();
                int n = frames.Count;
                double avgRms = n > 0 ? Math.Sqrt(sqSum / n) : 0;
                double lowRms = n > 0 ? Math.Sqrt(low / n) : 0;
                double midRms = n > 0 ? Math.Sqrt(mid / n) : 0;
                double highRms = n > 0 ? Math.Sqrt(high / n) : 0;
                double bandSum = lowRms + midRms + highRms;

                int silentFrames = 0;
                for (int i = 0; i < n; i++) if (dbList[i] < -55) silentFrames++;

                double bpmStrength;
                double bpm = EstimateBpm(out bpmStrength);

                var sb = new StringBuilder(700);
                sb.Append('{');
                sb.Append("\"ok\":").Append(lastError.Length == 0 ? "true" : "false");
                if (lastError.Length > 0) sb.Append(",\"error\":").Append(Str(lastError));
                sb.Append(",\"running\":").Append(running ? "true" : "false");
                sb.Append(",\"device\":").Append(Str(deviceName));
                sb.Append(",\"sampleRate\":").Append(sampleRate.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"channels\":").Append(channels.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"bits\":").Append(bits.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"packets\":").Append(packetsRead.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"frames\":").Append(totalFrames.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"staleMs\":").Append(((long)staleMs).ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"reopens\":").Append(reopenCount.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"windowMs\":").Append((n * FrameMs).ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"silentRatio\":").Append(Num(n > 0 ? (double)silentFrames / n : 1));
                sb.Append(",\"rmsDb\":").Append(Num(n > 0 ? Db(avgRms) : -120));
                sb.Append(",\"peakDb\":").Append(Num(Db(peak)));
                sb.Append(",\"dynamicDb\":").Append(Num(n > 0 ? Percentile(dbList, 0.95) - Percentile(dbList, 0.10) : 0));
                sb.Append(",\"band\":").Append(Band(bandSum > 1e-9 ? lowRms / bandSum : 0,
                    bandSum > 1e-9 ? midRms / bandSum : 0, bandSum > 1e-9 ? highRms / bandSum : 0));
                sb.Append(",\"zcr\":").Append(Num(n > 0 ? zcr / n : 0));
                sb.Append(",\"bpm\":").Append(Num(bpm));
                sb.Append(",\"bpmStrength\":").Append(Num(bpmStrength));
                sb.Append('}');
                return sb.ToString();
            }
        }

        public static string Status()
        {
            lock (gate)
            {
                long now = NowMs();
                return "{\"running\":" + (running ? "true" : "false")
                    + ",\"error\":" + Str(lastError)
                    + ",\"device\":" + Str(deviceName)
                    + ",\"reopens\":" + reopenCount.ToString(CultureInfo.InvariantCulture)
                    + ",\"uptimeMs\":" + (startTick == 0 ? 0 : now - startTick).ToString(CultureInfo.InvariantCulture)
                    + ",\"staleMs\":" + (lastPacketTick == 0 ? -1 : now - lastPacketTick).ToString(CultureInfo.InvariantCulture)
                    + "}";
            }
        }

        static string Num(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return "null";
            return Math.Round(v, 3).ToString("0.###", CultureInfo.InvariantCulture);
        }

        static string Band(double low, double mid, double high)
        {
            return "{\"low\":" + Num(low) + ",\"mid\":" + Num(mid) + ",\"high\":" + Num(high) + "}";
        }

        internal static string Str(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder(s.Length + 16);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }

    /** Friendly device name, read through the same property store the Sound control panel uses. */
    internal static class SimplePropertyStore
    {
        [StructLayout(LayoutKind.Sequential)]
        struct PropertyKey { public Guid fmtid; public uint pid; }

        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IPropertyStore
        {
            int GetCount(out uint count);
            int GetAt(uint index, out PropertyKey key);
            int GetValue(ref PropertyKey key, out PropVariant value);
            int SetValue(ref PropertyKey key, ref PropVariant value);
            int Commit();
        }

        [StructLayout(LayoutKind.Explicit)]
        struct PropVariant
        {
            [FieldOffset(0)] public ushort vt;
            [FieldOffset(8)] public IntPtr pointerValue;
        }

        public static string ReadDeviceName(object store)
        {
            try
            {
                var ps = (IPropertyStore)store;
                var key = new PropertyKey();
                key.fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0");
                key.pid = 14; // PKEY_Device_FriendlyName
                PropVariant value;
                if (ps.GetValue(ref key, out value) != 0) return "";
                if (value.vt != 31 || value.pointerValue == IntPtr.Zero) return ""; // VT_LPWSTR
                return Marshal.PtrToStringUni(value.pointerValue) ?? "";
            }
            catch { return ""; }
        }
    }

    /** Which processes hold an audio session, and whether that session is producing sound. */
    public static class AudioSessions
    {
        const int eRender = 0;
        const int eMultimedia = 1;
        const int CLSCTX_ALL = 23;

        [DllImport("ole32.dll")]
        static extern int CoTaskMemFree(IntPtr p);

        public static string List()
        {
            var sb = new StringBuilder(400);
            sb.Append('[');
            int written = 0;
            IMMDeviceEnumerator enumerator = null;
            IMMDevice device = null;
            IAudioSessionManager2 manager = null;
            IAudioSessionEnumerator sessionEnum = null;
            try
            {
                enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
                int hr = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia, out device);
                if (hr != 0) { sb.Append(']'); return sb.ToString(); }

                Guid iid = typeof(IAudioSessionManager2).GUID;
                object mgrObj;
                hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out mgrObj);
                if (hr != 0) { sb.Append(']'); return sb.ToString(); }
                manager = (IAudioSessionManager2)mgrObj;

                hr = manager.GetSessionEnumerator(out sessionEnum);
                if (hr != 0) { sb.Append(']'); return sb.ToString(); }

                int count;
                sessionEnum.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    IAudioSessionControl control;
                    if (sessionEnum.GetSession(i, out control) != 0) continue;
                    var control2 = control as IAudioSessionControl2;
                    string state = "unknown";
                    string process = "";
                    uint pid = 0;
                    bool systemSounds = false;
                    try
                    {
                        int raw;
                        if (control.GetState(out raw) == 0)
                            state = raw == 0 ? "inactive" : raw == 1 ? "active" : "expired";
                        if (control2 != null)
                        {
                            if (control2.GetProcessId(out pid) == 0 && pid != 0)
                            {
                                try { process = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant() + ".exe"; }
                                catch { process = ""; }
                            }
                            systemSounds = control2.IsSystemSoundsSession() == 0;
                        }
                    }
                    catch { }
                    finally { if (control != null) Marshal.ReleaseComObject(control); }

                    if (pid == 0 && systemSounds) continue;
                    if (pid == 0 && process.Length == 0) continue;
                    if (state == "expired") continue;
                    if (written > 0) sb.Append(',');
                    sb.Append("{\"process\":").Append(Engine.Str(process));
                    sb.Append(",\"pid\":").Append(pid.ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"state\":").Append(Engine.Str(state));
                    sb.Append('}');
                    written++;
                }
            }
            catch { }
            finally
            {
                if (sessionEnum != null) Marshal.ReleaseComObject(sessionEnum);
                if (manager != null) Marshal.ReleaseComObject(manager);
                if (device != null) Marshal.ReleaseComObject(device);
                if (enumerator != null) Marshal.ReleaseComObject(enumerator);
            }
            sb.Append(']');
            return sb.ToString();
        }
    }

    /**
     * Process starts from the kernel provider, through a real ETW-backed event log subscription.
     * Needs elevation: the analytic channel is disabled and cannot be enabled by a standard user.
     * Start() returns "" on success or the reason it could not subscribe.
     */
    public static class ProcWatch
    {
        const string Channel = "Microsoft-Windows-Kernel-Process/Analytic";
        static EventLogWatcher watcher;
        static readonly object gate = new object();
        static readonly List<KeyValuePair<long, string>> starts = new List<KeyValuePair<long, string>>();

        public static string Start()
        {
            lock (gate)
            {
                if (watcher != null) return "";
                try
                {
                    // Enable the analytic channel, which is off by default and needs admin.
                    var psi = new ProcessStartInfo("wevtutil.exe", "sl " + Channel + " /e:true")
                    {
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    };
                    using (var p = Process.Start(psi))
                    {
                        p.WaitForExit(5000);
                        if (p.ExitCode != 0) return "wevtutil exit " + p.ExitCode;
                    }

                    var query = new EventLogQuery(Channel, PathType.LogName)
                    {
                        TolerateQueryErrors = true
                    };
                    var local = new EventLogWatcher(query);
                    local.EventRecordWritten += OnRecord;
                    local.Enabled = true;
                    watcher = local;
                    return "";
                }
                catch (Exception ex)
                {
                    return ex.GetType().Name + ": " + ex.Message;
                }
            }
        }

        static void OnRecord(object sender, EventRecordWrittenEventArgs e)
        {
            if (e == null || e.EventRecord == null) return;
            try
            {
                using (var record = e.EventRecord)
                {
                    // Provider event id 1 is ProcessStart; its first field is the image name.
                    if (record.Id != 1) return;
                    string image = "";
                    try
                    {
                        if (record.Properties.Count > 0 && record.Properties[0].Value != null)
                            image = record.Properties[0].Value.ToString();
                    }
                    catch { }
                    if (image.Length == 0) return;
                    int slash = image.LastIndexOf('\\');
                    if (slash >= 0) image = image.Substring(slash + 1);
                    if (image.Length == 0) return;
                    lock (gate)
                    {
                        starts.Add(new KeyValuePair<long, string>(DateTime.UtcNow.Ticks, image.ToLowerInvariant()));
                        if (starts.Count > 256) starts.RemoveRange(0, starts.Count - 256);
                    }
                }
            }
            catch { }
        }

        /** Everything seen since the previous call, oldest first, then forget it. */
        public static string Drain()
        {
            lock (gate)
            {
                var sb = new StringBuilder(256);
                sb.Append('[');
                for (int i = 0; i < starts.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append("{\"name\":").Append(Engine.Str(starts[i].Value));
                    sb.Append(",\"ticks\":").Append(starts[i].Key.ToString(CultureInfo.InvariantCulture));
                    sb.Append('}');
                }
                sb.Append(']');
                starts.Clear();
                return sb.ToString();
            }
        }

        public static bool Active { get { lock (gate) return watcher != null; } }

        public static void Stop()
        {
            lock (gate)
            {
                if (watcher != null)
                {
                    try { watcher.Enabled = false; } catch { }
                    try { watcher.Dispose(); } catch { }
                    watcher = null;
                }
            }
        }
    }
}
