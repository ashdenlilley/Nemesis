package com.ashdenlilley.nemesis

import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.io.File

// M0 probe: run the bundled node and bash from nativeLibraryDir and show their output.
// Nothing here is the real terminal yet.
class MainActivity : AppCompatActivity() {

    private val output by lazy { TextView(this).apply { textSize = 13f; setPadding(32, 32, 32, 32) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(ScrollView(this).apply { addView(output) })
        Thread { output.post { output.text = probe() } }.start()
    }

    private fun probe(): String {
        val libDir = File(applicationInfo.nativeLibraryDir)
        val report = StringBuilder()
        report.append("nativeLibraryDir: ${libDir.path}\n")
        report.append("files: ${libDir.list()?.sorted()?.joinToString()}\n\n")

        for (name in listOf("libbash.so", "libnode.so")) {
            report.append("== $name ==\n")
            val exe = File(libDir, name)
            if (!exe.exists()) {
                report.append("missing\n\n")
                continue
            }
            val cmd = if (name == "libbash.so") {
                listOf(exe.path, "-c", "echo bash-ok; uname -m")
            } else {
                listOf(exe.path, "-e", "console.log('node-ok', process.version)")
            }
            report.append(run(cmd)).append("\n\n")
        }
        return report.toString()
    }

    private fun run(cmd: List<String>): String = try {
        val proc = ProcessBuilder(cmd).redirectErrorStream(true).start()
        val text = proc.inputStream.bufferedReader().readText()
        "exit=${proc.waitFor()}\n$text"
    } catch (e: Exception) {
        "error: ${e.javaClass.simpleName}: ${e.message}"
    }
}
