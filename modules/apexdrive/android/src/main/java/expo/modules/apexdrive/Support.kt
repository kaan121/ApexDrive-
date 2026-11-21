package expo.modules.apexdrive

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity
import android.os.SystemClock
import java.io.File

object Store {
  fun prefs(c: Context) = c.getSharedPreferences("apexdrive_native", Context.MODE_PRIVATE)
  fun dir(c: Context): File = File(c.filesDir, "apexdrive_trips").apply { mkdirs() }

  // Şu an kaydı süren sürüşün dosya adı (yoksa boş). Sistem servisi öldürüp bayrak açık kalırsa 10 dk sonra eski sayılır.
  fun activeName(c: Context): String {
    val p = prefs(c)
    val n = p.getString("cur", "") ?: ""
    if (!p.getBoolean("rec", false) || n.isEmpty()) return ""
    return if (System.currentTimeMillis() - File(dir(c), n).lastModified() < 600000L) n else ""
  }
}

// TEŞHİS: geçici algılama kaydı (sorun bulununca kaldırılacak)
object Diag {
  private val fmt = java.text.SimpleDateFormat("dd.MM HH:mm:ss", java.util.Locale.US)
  private fun file(c: Context) = File(c.filesDir, "apexdrive_diag.txt")

  @Synchronized fun add(c: Context, msg: String) {
    try {
      val f = file(c)
      if (f.length() > 30000) f.writeText(f.readLines().takeLast(150).joinToString("\n") + "\n")
      f.appendText(fmt.format(java.util.Date()) + " " + msg + "\n")
    } catch (e: Exception) {}
  }

  fun read(c: Context): String = try { file(c).readLines().takeLast(60).reversed().joinToString("\n") } catch (e: Exception) { "" }
}

object Transitions {
  private fun pending(c: Context): PendingIntent =
    PendingIntent.getBroadcast(c, 0, Intent(c, TransitionReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)

  fun register(c: Context, done: (Boolean) -> Unit = {}) {
    val types = listOf(ActivityTransition.ACTIVITY_TRANSITION_ENTER, ActivityTransition.ACTIVITY_TRANSITION_EXIT)
    val req = ActivityTransitionRequest(types.map {
      ActivityTransition.Builder().setActivityType(DetectedActivity.IN_VEHICLE).setActivityTransition(it).build()
    })
    try {
      ActivityRecognition.getClient(c).requestActivityTransitionUpdates(req, pending(c))
        .addOnSuccessListener { done(true) }
        .addOnFailureListener { done(false) }
    } catch (e: SecurityException) {
      done(false)
    }
  }

  fun unregister(c: Context) {
    try { ActivityRecognition.getClient(c).removeActivityTransitionUpdates(pending(c)) } catch (e: Exception) {}
  }
}

class TransitionReceiver : BroadcastReceiver() {
  override fun onReceive(c: Context, i: Intent) {
    if (!ActivityTransitionResult.hasResult(i)) return
    val events = ActivityTransitionResult.extractResult(i)?.transitionEvents ?: return
    val on = Store.prefs(c).getBoolean("enabled", false)
    for (e in events) { // TEŞHİS
      if (e.activityType != DetectedActivity.IN_VEHICLE) continue
      val ad = if (e.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER) "GIRDI" else "CIKTI"
      val age = (SystemClock.elapsedRealtimeNanos() - e.elapsedRealTimeNanos) / 1000000000L
      Diag.add(c, "aracta " + ad + " (olay " + age + " sn once geldi)" + (if (on) "" else ", algilama kapali"))
    }
    if (!on) return
    // Olaylar listede zaman sırasıyla gelmeyebilir; servisi açıp hemen kapatmamak için yalnızca en yeni "araçta" olayına bakılır
    val last = events.filter { it.activityType == DetectedActivity.IN_VEHICLE }.maxByOrNull { it.elapsedRealTimeNanos } ?: return
    if (last.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER) DriveService.start(c) else DriveService.stop(c)
  }
}

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(c: Context, i: Intent) {
    if (Store.prefs(c).getBoolean("enabled", false)) {
      Diag.add(c, "telefon acildi ya da uygulama guncellendi, algilama yeniden kuruldu") // TEŞHİS
      Transitions.register(c)
    }
  }
}
