using System;

/// <summary>
/// Standalone entry point for the one-shot taskbar overlay writer.
/// Running a precompiled small executable avoids starting Windows PowerShell
/// (and loading its ~50 MB runtime) for every badge count change.
/// </summary>
public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        long hwnd = 0;
        int count = 0;

        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i] ?? string.Empty;
            if (string.Equals(arg, "-WarmOnly", StringComparison.OrdinalIgnoreCase)) return 0;
            if (string.Equals(arg, "-Hwnd", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
            {
                long.TryParse(args[++i], out hwnd);
                continue;
            }
            if (string.Equals(arg, "-Count", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
            {
                int.TryParse(args[++i], out count);
                continue;
            }
        }

        if (hwnd == 0) return 2;
        try
        {
            DshTaskbarBadge.Set(new IntPtr(hwnd), count);
            return 0;
        }
        catch
        {
            return 1;
        }
    }
}
