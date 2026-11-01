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

        using (var bitmap = new Bitmap(32, 32))
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            graphics.Clear(Color.Transparent);

            // 1-3: a graphite count disc with a thin Fluent-style blue rim.
            // This follows the neutral/accent direction of GitHub Primer's
            // badge tokens and Fluent UI's filled badge, instead of the harsh
            // saturated red block. 4+: a small red dot with a white halo, so
            // the "more than three" state remains an unread indicator without
            // asking Windows to render a two-digit number in 16 px.
            int size = overflow ? 16 : 30;
            int offset = (32 - size) / 2;
            Color fillColor = overflow
                ? Color.FromArgb(255, 196, 49, 75)   // #C4314B, muted GitHub danger
                : Color.FromArgb(245, 31, 35, 40);   // #1F2328, Primer neutral emphasis
            using (var fill = new SolidBrush(fillColor))
            {
                graphics.FillEllipse(fill, offset, offset, size, size);
            }

            if (overflow)
            {
                using (var halo = new Pen(Color.FromArgb(235, 255, 255, 255), 2f))
                {
                    graphics.DrawEllipse(halo, offset, offset, size, size);
                }
            }
            else
            {
                // Brand-blue rim: recognizable without the urgency of red.
                using (var rim = new Pen(Color.FromArgb(255, 47, 129, 247), 2f))
                {
                    graphics.DrawEllipse(rim, 1, 1, 30, 30);
                }
                // Segoe UI Black + a 20 px glyph. Center the actual glyph path,
                // not DrawString's padded layout box: this keeps "1", "2" and
                // "3" optically centered and maximises their footprint in the
                // 30 px disc after Windows scales it to the 16 px overlay.
                using (var font = new Font("Segoe UI Black", 20f, FontStyle.Regular, GraphicsUnit.Pixel))
                using (var textBrush = new SolidBrush(Color.White))
                using (var format = new StringFormat(StringFormat.GenericTypographic))
                using (var path = new GraphicsPath())
                {
                    path.AddString(shown.ToString(), font.FontFamily, (int)font.Style, font.Size, PointF.Empty, format);
                    RectangleF bounds = path.GetBounds();
                    float dx = (32f - bounds.Width) / 2f - bounds.X;
                    float dy = (32f - bounds.Height) / 2f - bounds.Y;
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
