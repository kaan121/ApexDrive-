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
    if (!Store.prefs(c).getBoolean("enabled", false)) return
    val events = ActivityTransitionResult.extractResult(i)?.transitionEvents ?: return
    // Toplu gelen eski olaylarda servisi açıp hemen kapatmamak için yalnızca son "araçta" olayına bakılır
    val last = events.lastOrNull { it.activityType == DetectedActivity.IN_VEHICLE } ?: return
    if (last.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER) DriveService.start(c) else DriveService.stop(c)
  }
}

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(c: Context, i: Intent) {
    if (Store.prefs(c).getBoolean("enabled", false)) Transitions.register(c)
  }
}
