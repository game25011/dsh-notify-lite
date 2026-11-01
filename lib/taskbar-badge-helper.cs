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

            // 1-3: a full red count disc. 4+: a smaller plain red dot so the
            // taskbar never has to render an unreadable two-digit number.
            int size = overflow ? 18 : 30;
            int offset = (32 - size) / 2;
            using (var fill = new SolidBrush(Color.FromArgb(255, 208, 45, 45)))
            {
                graphics.FillEllipse(fill, offset, offset, size, size);
            }
            using (var border = new Pen(Color.FromArgb(230, 255, 255, 255), 1.4f))
            {
                graphics.DrawEllipse(border, offset, offset, size, size);
            }

            if (!overflow)
            {
                using (var font = new Font("Segoe UI", 18f, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var textBrush = new SolidBrush(Color.White))
                using (var format = new StringFormat())
                {
                    format.Alignment = StringAlignment.Center;
                    format.LineAlignment = StringAlignment.Center;
                    graphics.DrawString(shown.ToString(), font, textBrush, new RectangleF(0, 0, 32, 32), format);
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
