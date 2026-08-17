$ErrorActionPreference = "Stop"

# ConPTY bridge host: creates a real Windows pseudo console, spawns the child
# console program inside it, and bridges the parent's stdin/stdout pipes to the
# pseudo console. The child command and environment come from the CONPTY_SPEC
# JSON environment variable. ConPTY is the same mechanism Windows Terminal
# uses; no third-party tool is required on Windows 10 1809+.

# The child command spec arrives through the CONPTY_SPEC environment variable;
# a command-line parameter would be mangled by Windows quoting of the JSON.
$Spec = $env:CONPTY_SPEC
if ([string]::IsNullOrWhiteSpace($Spec)) {
  throw "CONPTY_SPEC environment variable is required."
}

$csharp = @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class ConPty {
    [StructLayout(LayoutKind.Sequential)]
    public struct Coord { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct StartupInfoEx {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SecurityAttributes {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessInformation {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = new IntPtr(0x20016);
    private const int STD_INPUT_HANDLE = -10;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SecurityAttributes lpPipeAttributes, int nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(Coord size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int ResizePseudoConsole(IntPtr hPC, Coord size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int CreateProcessW(string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref StartupInfoEx lpStartupInfo, out ProcessInformation lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int WriteFile(IntPtr hFile, byte[] lpBuffer, int nNumberOfBytesToWrite, out int lpNumberOfBytesWritten, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int ReadFile(IntPtr hFile, byte[] lpBuffer, int nNumberOfBytesToRead, out int lpNumberOfBytesRead, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int GetExitCodeProcess(IntPtr hProcess, out int lpExitCode);

    private static IntPtr _hPc;
    private static IntPtr _hInputWrite;
    private static IntPtr _hOutputRead;
    private static IntPtr _hProcess;
    private static IntPtr _hThread;
    private static readonly object WriteLock = new object();

    public static int Run(string exe, string[] args, string cwd, short cols, short rows, string logFile) {
        try {
            IntPtr hInputRead;
            IntPtr hOutputWrite;
            SecurityAttributes inherit = new SecurityAttributes();
            inherit.nLength = Marshal.SizeOf(typeof(SecurityAttributes));
            inherit.bInheritHandle = true;
            if (CreatePipe(out hInputRead, out _hInputWrite, ref inherit, 0) == 0) throw new IOException("CreatePipe(input) failed: " + Marshal.GetLastWin32Error());
            if (CreatePipe(out _hOutputRead, out hOutputWrite, ref inherit, 0) == 0) throw new IOException("CreatePipe(output) failed: " + Marshal.GetLastWin32Error());
            Coord size = new Coord { X = cols, Y = rows };
            int createPcResult = CreatePseudoConsole(size, hInputRead, hOutputWrite, 0, out _hPc);
            if (createPcResult != 0) throw new IOException("CreatePseudoConsole failed: " + Marshal.GetLastWin32Error());

            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            IntPtr attributeList = Marshal.AllocHGlobal(attributeSize);
            if (InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize) == 0) throw new IOException("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());

            StartupInfoEx siex = new StartupInfoEx();
            siex.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            // node-pty pattern: STARTF_USESTDHANDLES with NULL standard handles;
            // the system connects the child's standard handles to the pseudo
            // console because PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE is set.
            siex.StartupInfo.dwFlags = 0x00000001 | 0x00000100; // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
            siex.StartupInfo.wShowWindow = 0;
            siex.StartupInfo.hStdInput = IntPtr.Zero;
            siex.StartupInfo.hStdOutput = IntPtr.Zero;
            siex.StartupInfo.hStdError = IntPtr.Zero;
            siex.lpAttributeList = attributeList;
            if (UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, _hPc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero) == 0)
                throw new IOException("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());

            string commandLine = BuildCommandLine(exe, args);
            ProcessInformation pi;
            bool created = CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, cwd, ref siex, out pi) != 0;
            DeleteProcThreadAttributeList(attributeList);
            Marshal.FreeHGlobal(attributeList);
            if (!created) throw new IOException("CreateProcessW failed: " + Marshal.GetLastWin32Error() + " command=" + commandLine);
            _hProcess = pi.hProcess;
            _hThread = pi.hThread;

            // The parent no longer needs the pseudo-console ends of the pipes.
            CloseHandle(hInputRead);
            CloseHandle(hOutputWrite);

            TextWriter log = null;
            if (!string.IsNullOrEmpty(logFile)) log = new StreamWriter(logFile, false, new System.Text.UTF8Encoding(false));

            // Output thread: pseudo console -> parent stdout (and optional log).
            Thread outputThread = new Thread(delegate () {
                byte[] buffer = new byte[65536];
                Stream stdout = Console.OpenStandardOutput();
                while (true) {
                    int read;
                    if (ReadFile(_hOutputRead, buffer, buffer.Length, out read, IntPtr.Zero) == 0 || read <= 0) break;
                    try {
                        stdout.Write(buffer, 0, read);
                        stdout.Flush();
                    } catch (IOException) { break; }
                    catch (ObjectDisposedException) { break; }
                    if (log != null) { try { log.Write(System.Text.Encoding.UTF8.GetString(buffer, 0, read)); log.Flush(); } catch (Exception) { } }
                }
            });
            outputThread.IsBackground = true;
            outputThread.Start();

            // Input thread: parent stdin -> pseudo console input.
            Thread inputThread = new Thread(delegate () {
                byte[] buffer = new byte[4096];
                Stream stdin = Console.OpenStandardInput();
                while (true) {
                    int read;
                    try { read = stdin.Read(buffer, 0, buffer.Length); }
                    catch (IOException) { break; }
                    catch (ObjectDisposedException) { break; }
                    if (read <= 0) break;
                    lock (WriteLock) {
                        int written;
                        if (WriteFile(_hInputWrite, buffer, read, out written, IntPtr.Zero) == 0) break;
                    }
                }
            });
            inputThread.IsBackground = true;
            inputThread.Start();

            WaitForSingleObject(_hProcess, 0xFFFFFFFF);
            int exitCode = 0;
            GetExitCodeProcess(_hProcess, out exitCode);

            // Give the output thread a moment to drain remaining bytes.
            Thread.Sleep(200);
            if (log != null) { log.Flush(); log.Close(); }
            return exitCode;
        } finally {
            Cleanup();
        }
    }

    private static string BuildCommandLine(string exe, string[] args) {
        System.Collections.Generic.List<string> parts = new System.Collections.Generic.List<string>();
        parts.Add(Quote(exe));
        foreach (string arg in args) parts.Add(Quote(arg));
        return string.Join(" ", parts.ToArray());
    }

    private static string Quote(string value) {
        if (value.Length == 0) return "\"\"";
        if (value.IndexOf(' ') < 0 && value.IndexOf('\t') < 0) return value;
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void Cleanup() {
        try { if (_hPc != IntPtr.Zero) ClosePseudoConsole(_hPc); } catch (Exception) { }
        try { if (_hInputWrite != IntPtr.Zero) CloseHandle(_hInputWrite); } catch (Exception) { }
        try { if (_hOutputRead != IntPtr.Zero) CloseHandle(_hOutputRead); } catch (Exception) { }
        try { if (_hProcess != IntPtr.Zero) CloseHandle(_hProcess); } catch (Exception) { }
        try { if (_hThread != IntPtr.Zero) CloseHandle(_hThread); } catch (Exception) { }
    }
}
"@

Add-Type -TypeDefinition $csharp -Language CSharp

$spec = $Spec | ConvertFrom-Json
$envBlock = $spec.env
if ($envBlock) {
  foreach ($property in $envBlock.PSObject.Properties) {
    [System.Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, "Process")
  }
}

$exitCode = [ConPty]::Run(
  $spec.exe,
  [string[]]$spec.args,
  $spec.cwd,
  [int16]$spec.cols,
  [int16]$spec.rows,
  $spec.logFile
)
exit $exitCode
