using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;

// Minimal ITaskbarList3 surface. Only SetOverlayIcon is used here, but the
// vtable order must match the Windows SDK exactly.
[ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ITaskbarList3
{
    void HrInit();
    void AddTab(IntPtr hwnd);
    void DeleteTab(IntPtr hwnd);
    void ActivateTab(IntPtr hwnd);
    void SetActiveAlt(IntPtr hwnd);
    void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fFullscreen);
    void SetProgressValue(IntPtr hwnd, ulong ullCompleted, ulong ullTotal);
    void SetProgressState(IntPtr hwnd, int tbpFlags);
    void RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
    void UnregisterTab(IntPtr hwndTab);
    void SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
    void SetTabActive(IntPtr hwndTab, IntPtr hwndMDI, uint dwReserved);
    void ThumbBarAddButtons(IntPtr hwnd, uint cButtons, IntPtr pButtons);
    void ThumbBarUpdateButtons(IntPtr hwnd, uint cButtons, IntPtr pButtons);
    void ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
    void SetOverlayIcon(IntPtr hwnd, IntPtr hIcon, [MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
    void SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string pszTip);
    void SetThumbnailClip(IntPtr hwnd, IntPtr prcClip);
}

[ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
internal class CTaskbarList
{
}

/// <summary>
/// One-shot taskbar overlay badge writer. The process owns the HICON only
/// until it exits; Windows keeps the rendered overlay after that, which keeps
/// the helper tiny and avoids a long-lived process.
/// </summary>
public static class DshTaskbarBadge
{
    private const int SM_CXSMICON = 49;
    // 0.5.1 rendered a 20 px glyph on a 32 px bitmap and let the shell
    // downscale it. 0.58 of the native overlay was 30-40% larger and read
    // as too wide; 0.46 keeps the old optical size with about 10% extra
    // height/weight at 16/20/24/32 px.
    private const float NumeralHeightRatio = 0.46f;

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetricsForDpi(int index, uint dpi);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    /// <summary>
    /// The overlay slot is the taskbar's small-icon size at the taskbar's DPI
    /// (16 px at 100 %, 20 at 125 %, 24 at 150 %, 32 at 200 %). Drawing at
    /// exactly that size avoids the blur of letting the shell resample a
    /// fixed 32 px bitmap. Falls back to 16 px on older Windows builds.
    /// </summary>
    private static int OverlaySize(IntPtr hwnd)
    {
        try
        {
            uint dpi = 0;
            IntPtr tray = FindWindow("Shell_TrayWnd", null);
            if (tray != IntPtr.Zero) dpi = GetDpiForWindow(tray);
            if (dpi == 0) dpi = GetDpiForWindow(hwnd);
            if (dpi == 0) return 16;
            int size = GetSystemMetricsForDpi(SM_CXSMICON, dpi);
            if (size < 16) return 16;
            return size > 64 ? 64 : size;
        }
        catch
        {
            // GetDpiForWindow / GetSystemMetricsForDpi need Windows 10 1607+.
            return 16;
        }
    }

    /// <summary>Segoe UI Black, or the generic sans family if it is missing.</summary>
    private static FontFamily NumeralFamily()
    {
        try
        {
            return new FontFamily("Segoe UI Black");
        }
        catch (ArgumentException)
        {
            return new FontFamily(GenericFontFamilies.SansSerif);
        }
    }

    public static void Set(IntPtr hwnd, int count)
    {
        if (hwnd == IntPtr.Zero) return;

        var taskbar = (ITaskbarList3)new CTaskbarList();
        taskbar.HrInit();

        if (count <= 0)
        {
            taskbar.SetOverlayIcon(hwnd, IntPtr.Zero, string.Empty);
            return;
        }

        int shown = count > 3 ? 3 : count;
        bool overflow = count > 3;
        int s = OverlaySize(hwnd);
        // One device pixel per 16 px of overlay: 1 px at 100 %, 2 px at 200 %.
        float line = Math.Max(1f, (float)Math.Round(s / 16f));

        using (var bitmap = new Bitmap(s, s, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            // Half-pixel offset makes geometry coordinates pixel edges, so an
            // integer rectangle covers whole pixels instead of straddling them.
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.Clear(Color.Transparent);

            // 1-3: a graphite count disc with a thin Fluent-style blue rim.
            // This follows the neutral/accent direction of GitHub Primer's
            // badge tokens and Fluent UI's filled badge, instead of the harsh
            // saturated red block. 4+: a small red dot with a white halo, so
            // the "more than three" state remains an unread indicator without
            // asking Windows to render a two-digit number in 16 px.
            if (overflow)
            {
                // An even/odd-matched diameter keeps the dot centred on the
                // pixel grid; about half of the slot, as before.
                int dot = (int)Math.Round(s * 0.5);
                if ((s - dot) % 2 != 0) dot += 1;
                float inset = (s - dot) / 2f;
                using (var halo = new SolidBrush(Color.FromArgb(235, 255, 255, 255)))
                {
                    graphics.FillEllipse(halo, inset - line, inset - line, dot + 2 * line, dot + 2 * line);
                }
                using (var fill = new SolidBrush(Color.FromArgb(255, 196, 49, 75)))   // #C4314B, muted GitHub danger
                {
                    graphics.FillEllipse(fill, inset, inset, dot, dot);
                }
            }
            else
            {
                // Brand-blue rim as an outer disc, graphite face inset by one
                // device pixel: two fills stay crisper than a stroked ellipse.
                using (var rim = new SolidBrush(Color.FromArgb(255, 47, 129, 247)))
                {
                    graphics.FillEllipse(rim, 0, 0, s, s);
                }
                using (var face = new SolidBrush(Color.FromArgb(255, 31, 35, 40)))   // #1F2328, Primer neutral emphasis
                {
                    graphics.FillEllipse(face, line, line, s - 2 * line, s - 2 * line);
                }
                // Segoe UI Black numeral. Scale the real glyph outline to a
                // whole-pixel height and snap its origin to the grid, so the
                // top/bottom edges and the stems land on pixel boundaries
                // instead of being smeared by fractional placement.
                using (var family = NumeralFamily())
                using (var textBrush = new SolidBrush(Color.White))
                using (var format = new StringFormat(StringFormat.GenericTypographic))
                using (var path = new GraphicsPath())
                {
                    path.AddString(shown.ToString(), family, (int)FontStyle.Regular, 100f, PointF.Empty, format);
                    RectangleF raw = path.GetBounds();
                    float targetHeight = (float)Math.Round(s * NumeralHeightRatio);
                    float scale = raw.Height > 0 ? targetHeight / raw.Height : 1f;
                    using (var matrix = new Matrix())
                    {
                        matrix.Scale(scale, scale);
                        path.Transform(matrix);
                    }
                    RectangleF bounds = path.GetBounds();
                    float left = (float)Math.Round((s - bounds.Width) / 2f);
                    float top = (float)Math.Round((s - bounds.Height) / 2f);
                    float dx = left - bounds.X;
                    float dy = top - bounds.Y;
                    using (var matrix = new Matrix())
                    {
                        matrix.Translate(dx, dy);
                        path.Transform(matrix);
                    }
                    graphics.FillPath(textBrush, path);
                }
            }

            // Do not destroy this HICON: the taskbar retains the overlay after
            // this one-shot helper exits. Windows reclaims the icon with the
            // helper's process resources.
            string description = overflow ? "More than 3 completed sessions" : (count == 1 ? "1 completed session" : count + " completed sessions");
            taskbar.SetOverlayIcon(hwnd, bitmap.GetHicon(), description);
        }
    }
}
