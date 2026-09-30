// Windows 需要原生 CLI 路径；此测试程序不启动真实 Codex 或其他子进程。
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

public static class MockCodex {
    public static void Main() {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string line;
        while ((line = Console.ReadLine()) != null) {
            Match id = Regex.Match(line, "\"id\"\\s*:\\s*(\\d+)");
            if (!id.Success) continue;
            string method = Regex.Match(line, "\"method\"\\s*:\\s*\"([^\"]+)\"").Groups[1].Value;
            File.AppendAllText(Path.Combine(root, "mock-requests.log"), method + "\n");
            try {
                string dataRoot = root;
                string home = Environment.GetEnvironmentVariable("CODEX_HOME");
                if (!String.IsNullOrEmpty(home) && File.Exists(Path.Combine(home, "auth.json"))) {
                    string auth = File.ReadAllText(Path.Combine(home, "auth.json"), Encoding.UTF8);
                    Match profile = Regex.Match(auth, "\"mockProfile\"\\s*:\\s*\"([^\"]+)\"");
                    if (profile.Success) dataRoot = profile.Groups[1].Value;
                }
                string result;
                if (method == "initialize") result = "{}";
                else {
                    string file = method == "account/read" ? "mock-account.json"
                        : method == "account/rateLimits/read" ? "mock-usage.json" : null;
                    if (file == null) throw new InvalidOperationException("unsupported");
                    result = File.ReadAllText(Path.Combine(dataRoot, file), Encoding.UTF8);
                }
                Console.WriteLine("{\"id\":" + id.Groups[1].Value + ",\"result\":" + result + "}");
            } catch {
                Console.WriteLine("{\"id\":" + id.Groups[1].Value
                    + ",\"error\":{\"code\":-32000,\"message\":\"Mock response unavailable\"}}");
            }
        }
    }
}
