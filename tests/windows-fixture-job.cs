using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public sealed class FixtureJob : IDisposable {
    const int BasicAccountingInformation = 1, ExtendedLimitInformation = 9;
    const uint KillOnJobClose = 0x2000;
    [StructLayout(LayoutKind.Sequential)]
    struct Limits {
        public long ProcessTime, JobTime;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32", SetLastError=true)] static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref Limits info, int size);
    [DllImport("kernel32", SetLastError=true)] static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out Accounting info, int size, IntPtr returned);
    [DllImport("kernel32", SetLastError=true)] static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32", SetLastError=true)] static extern bool TerminateJobObject(SafeFileHandle job, uint code);
    readonly SafeFileHandle job = CreateJobObject(IntPtr.Zero, null);
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public FixtureJob() {
        Check(!job.IsInvalid);
        var limits = new Limits { LimitFlags = KillOnJobClose };
        Check(SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(Limits))));
    }
    uint Active() {
        Accounting info;
        Check(QueryInformationJobObject(job, BasicAccountingInformation, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return info.ActiveProcesses;
    }
    public void Assign(Process process) {
        Check(AssignProcessToJobObject(job, process.Handle));
        if (Active() != 1) throw new InvalidOperationException("Job did not see its gated shell");
    }
    public void StopAndWait() {
        if (Active() == 0) return;
        Check(TerminateJobObject(job, 1));
        var clock = Stopwatch.StartNew();
        while (Active() != 0) {
            if (clock.ElapsedMilliseconds >= 5000) throw new TimeoutException("Fixture job still has active processes");
            Thread.Sleep(25);
        }
    }
    public void Dispose() { job.Dispose(); }
    public static int Main(string[] args) {
        using (var job = new FixtureJob())
        using (var shell = new Process()) {
            bool started = false;
            int code = 1;
            try {
                string comspec = Environment.GetEnvironmentVariable("ComSpec");
                shell.StartInfo.FileName = String.IsNullOrEmpty(comspec) ? "cmd.exe" : comspec;
                shell.StartInfo.Arguments = "/d /q /s /c \"set /p VARGUS_READY= >nul && " + args[0] + "\"";
                shell.StartInfo.UseShellExecute = false;
                shell.StartInfo.CreateNoWindow = true;
                shell.StartInfo.RedirectStandardInput = true;
                started = shell.Start();
                var identity = String.Format("PID {0}, started {1:o}", shell.Id, shell.StartTime.ToUniversalTime());
                job.Assign(shell);
                shell.StandardInput.WriteLine("run");
                shell.StandardInput.Close();
                if (!shell.WaitForExit(Int32.Parse(args[1]))) {
                    code = 124;
                    throw new TimeoutException(args[0] + " timed out (" + identity + ")");
                }
                code = shell.ExitCode;
                if (code != 0) Console.Error.WriteLine("{0} exited with {1} ({2})", args[0], code, identity);
            } catch (Exception error) {
                Console.Error.WriteLine(error.Message);
            } finally {
                try {
                    if (started) shell.StandardInput.Close();
                    job.StopAndWait();
                    if (started && !shell.WaitForExit(5000)) throw new TimeoutException("Gated shell did not exit");
                    System.IO.File.WriteAllText(args[2], "");
                } catch (Exception error) {
                    Console.Error.WriteLine("Fixture cleanup: " + error.Message);
                    if (code == 0) code = 1;
                }
            }
            return code;
        }
    }
}
