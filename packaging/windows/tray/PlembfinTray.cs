using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.ServiceProcess;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Program
{
    private const string ServiceName = "Plembfin";
    private const string DashboardUrl = "http://127.0.0.1:5055";
    private const string StartupSubKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    private const string StartupValueName = "Plembfin";
    private static readonly HttpClient Http = new HttpClient
    {
        Timeout = TimeSpan.FromSeconds(3),
    };

    private static NotifyIcon trayIcon;
    private static Icon trayIconImage;
    private static ToolStripMenuItem statusItem;
    private static ToolStripMenuItem startupItem;
    private static Mutex singleInstance;

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length > 0 && string.Equals(args[0], "--open", StringComparison.OrdinalIgnoreCase))
        {
            WaitForHealthyService(TimeSpan.FromSeconds(15));
            Open(DashboardUrl);
            return;
        }

        bool createdNew;
        singleInstance = new Mutex(true, "Local\\Plembfin.NotificationArea", out createdNew);
        if (!createdNew)
        {
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
        trayIconImage = new Icon(Path.Combine(baseDirectory, "plembfin.ico"));
        statusItem = new ToolStripMenuItem("Status: checking...")
        {
            Enabled = false,
        };

        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("Open Plembfin", null, delegate { Open(DashboardUrl); });
        menu.Items.Add(statusItem);
        menu.Items.Add("Refresh status", null, delegate { UpdateStatus(); });
        menu.Items.Add("Stop server", null, delegate { StopServer(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open data folder", null, delegate { Open(GetDataDirectory()); });
        menu.Items.Add("Open logs folder", null, delegate { Open(Path.Combine(GetDataDirectory(), "logs")); });
        menu.Items.Add(new ToolStripSeparator());
        startupItem = new ToolStripMenuItem("Start Plembfin when I sign in")
        {
            CheckOnClick = true,
            Checked = IsStartupEnabled(),
        };
        startupItem.Click += delegate { SetStartup(startupItem.Checked); };
        menu.Items.Add(startupItem);
        menu.Items.Add("Exit notification area icon", null, delegate { Application.Exit(); });

        trayIcon = new NotifyIcon
        {
            ContextMenuStrip = menu,
            Icon = trayIconImage,
            Text = "Plembfin",
            Visible = true,
        };
        trayIcon.DoubleClick += delegate { Open(DashboardUrl); };

        var timer = new System.Windows.Forms.Timer { Interval = 30000 };
        timer.Tick += delegate { UpdateStatus(); };
        timer.Start();

        Application.ApplicationExit += delegate
        {
            timer.Stop();
            timer.Dispose();
            if (trayIcon != null)
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
            }
            if (trayIconImage != null)
            {
                trayIconImage.Dispose();
            }
            if (singleInstance != null)
            {
                singleInstance.ReleaseMutex();
                singleInstance.Dispose();
            }
        };

        UpdateStatus();
        Application.Run();
    }

    private static void UpdateStatus()
    {
        bool serviceInstalled = false;
        bool serviceAccessDenied = false;
        bool healthy = false;
        try
        {
            using (var service = new ServiceController(ServiceName))
            {
                serviceInstalled = true;
                if (service.Status == ServiceControllerStatus.Running)
                {
                    healthy = IsHealthy();
                }
            }
        }
        catch (InvalidOperationException error)
        {
            if (IsAccessDenied(error))
            {
                serviceInstalled = true;
                serviceAccessDenied = true;
                healthy = IsHealthy();
            }
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            if (IsAccessDenied(error))
            {
                serviceInstalled = true;
                serviceAccessDenied = true;
                healthy = IsHealthy();
            }
        }

        string status;
        if (!serviceInstalled)
        {
            status = "Not installed";
        }
        else if (healthy)
        {
            status = "Running";
        }
        else if (serviceAccessDenied)
        {
            status = "Installed (administrator access required)";
        }
        else
        {
            status = "Starting or unavailable";
        }

        if (statusItem != null)
        {
            statusItem.Text = "Status: " + status;
        }
        if (trayIcon != null)
        {
            trayIcon.Text = "Plembfin - " + status;
        }
    }

    private static bool IsHealthy()
    {
        try
        {
            using (HttpResponseMessage response = Http.GetAsync(DashboardUrl + "/health").ConfigureAwait(false).GetAwaiter().GetResult())
            {
                return response.IsSuccessStatusCode;
            }
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (TaskCanceledException)
        {
            return false;
        }
    }

    private static void WaitForHealthyService(TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (IsHealthy())
            {
                return;
            }
            Thread.Sleep(500);
        }
    }

    private static void StopServer()
    {
        DialogResult confirmation = MessageBox.Show(
            "Stop the Plembfin server? The dashboard and background synchronisation will be unavailable until the service is started again.",
            "Stop Plembfin server",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (confirmation != DialogResult.Yes)
        {
            return;
        }

        try
        {
            bool stoppedWithElevation = false;
            using (var service = new ServiceController(ServiceName))
            {
                try
                {
                    service.Refresh();
                    if (service.Status == ServiceControllerStatus.Stopped)
                    {
                        UpdateStatus();
                        return;
                    }

                    service.Stop();
                }
                catch (Exception error)
                {
                    // ServiceController reports an access-denied service handle as
                    // InvalidOperationException with a Win32Exception inner error.
                    // Fall back to an elevated Service Control Manager command for
                    // both wrapped and direct access-denied responses.
                    if (!IsAccessDenied(error))
                    {
                        throw;
                    }

                    // Standard users may need to approve a UAC prompt to stop the service.
                    if (!RunElevatedServiceCommand("stop"))
                    {
                        return;
                    }
                    stoppedWithElevation = true;
                }

                if (!stoppedWithElevation)
                {
                    service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
                }
            }

            UpdateStatus();
        }
        catch (InvalidOperationException error)
        {
            if (IsAccessDenied(error))
            {
                if (RunElevatedServiceCommand("stop"))
                {
                    UpdateStatus();
                }
                return;
            }

            ShowWarning(
                "Plembfin could not find its Windows service. It may not be installed yet.",
                error);
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            if (IsAccessDenied(error))
            {
                if (RunElevatedServiceCommand("stop"))
                {
                    UpdateStatus();
                }
                return;
            }

            ShowWarning(
                "Plembfin could not stop its Windows service. Windows may require administrator approval.",
                error);
        }
        catch (Exception error)
        {
            ShowWarning("Plembfin could not stop its Windows service.", error);
        }
    }

    private static bool IsAccessDenied(Exception error)
    {
        for (Exception current = error; current != null; current = current.InnerException)
        {
            if (current is UnauthorizedAccessException)
            {
                return true;
            }

            var win32 = current as System.ComponentModel.Win32Exception;
            if (win32 != null && (win32.NativeErrorCode == 5 || win32.NativeErrorCode == 1314))
            {
                return true;
            }
        }

        return false;
    }

    private static bool RunElevatedServiceCommand(string command)
    {
        try
        {
            using (Process process = Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.SystemDirectory, "sc.exe"),
                Arguments = command + " \"" + ServiceName + "\"",
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden,
            }))
            {
                if (process == null)
                {
                    return false;
                }

                process.WaitForExit();
                return process.ExitCode == 0 || (command == "stop" && process.ExitCode == 1062);
            }
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            // ERROR_CANCELLED: the user dismissed the UAC prompt.
            if (error.NativeErrorCode == 1223)
            {
                return false;
            }

            throw;
        }
    }

    private static void ShowWarning(string message, Exception error)
    {
        MessageBox.Show(
            message + "\r\n\r\n" + error.Message,
            "Plembfin",
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning);
    }

    private static string GetDataDirectory()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "Plembfin");
    }

    private static bool IsStartupEnabled()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(StartupSubKey, false))
            {
                string value = key == null ? null : key.GetValue(StartupValueName) as string;
                return !string.IsNullOrWhiteSpace(value)
                    && value.IndexOf(Application.ExecutablePath, StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static void SetStartup(bool enabled)
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(StartupSubKey))
            {
                if (enabled)
                {
                    key.SetValue(StartupValueName, "\"" + Application.ExecutablePath + "\"", RegistryValueKind.String);
                }
                else
                {
                    key.DeleteValue(StartupValueName, false);
                }
            }
        }
        catch (Exception error)
        {
            startupItem.Checked = !enabled;
            MessageBox.Show(
                "Plembfin could not update its sign-in setting.\r\n\r\n" + error.Message,
                "Plembfin",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private static void Open(string target)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = target,
                UseShellExecute = true,
            });
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "Plembfin could not open the requested location.\r\n\r\n" + error.Message,
                "Plembfin",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }
}
