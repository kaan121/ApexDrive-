package expo.modules.apexdrive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import java.io.File
import java.io.FileWriter

// Araca binince başlar, noktaları "zaman,enlem,boylam,hız,doğruluk,yön" satırları olarak dosyaya yazar.
// Araçtan inince (ya da 5 dk hareketsiz kalınca) durur; dosyayı uygulama açılınca okur.
class DriveService : Service() {
  private var client: FusedLocationProviderClient? = null
  private var out: FileWriter? = null
  private var lastMove = 0L

  private val callback = object : LocationCallback() {
    override fun onLocationResult(r: LocationResult) {
      val w = out ?: return
      val now = System.currentTimeMillis()
      for (l in r.locations) {
        if (l.accuracy > 50f) continue
        val speed = if (l.hasSpeed()) l.speed else -1f
        val bearing = if (l.hasBearing()) l.bearing else -1f
        w.write("${l.time},${l.latitude},${l.longitude},$speed,${l.accuracy},$bearing\n")
        if (speed > 1.5f) lastMove = now
      }
      w.flush()
      if (now - lastMove > IDLE_MS) stopSelf()
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    goForeground()
    if (client != null) return START_STICKY
    val p = Store.prefs(this)
    var name = Store.activeName(this)
    if (name.isEmpty()) name = "trip_${System.currentTimeMillis()}_${p.getString("veh", "v0")}.jsonl"
    p.edit().putString("cur", name).putBoolean("rec", true).apply()
    lastMove = System.currentTimeMillis()
    out = FileWriter(File(Store.dir(this), name), true)
    val c = LocationServices.getFusedLocationProviderClient(this)
    client = c
    val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000L).setMinUpdateIntervalMillis(1000L).build()
    try {
      c.requestLocationUpdates(req, callback, Looper.getMainLooper())
    } catch (e: SecurityException) {
      stopSelf()
    }
    return START_STICKY
  }

  private fun goForeground() {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CH, "Sürüş kaydı", NotificationManager.IMPORTANCE_LOW))
    val icon = resources.getIdentifier("notification_icon", "drawable", packageName).takeIf { it != 0 } ?: applicationInfo.icon
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE) }
    val n = NotificationCompat.Builder(this, CH)
      .setSmallIcon(icon)
      .setContentTitle("ApexDrive")
      .setContentText("Sürüşün kaydediliyor")
      .setOngoing(true)
      .setContentIntent(open)
      .build()
    if (Build.VERSION.SDK_INT >= 29) startForeground(NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION) else startForeground(NID, n)
  }

  override fun onDestroy() {
    client?.removeLocationUpdates(callback)
    client = null
    try { out?.close() } catch (e: Exception) {}
    out = null
    Store.prefs(this).edit().putBoolean("rec", false).apply()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    private const val CH = "apexdrive_drive"
    private const val NID = 4107
    private const val IDLE_MS = 300000L
    fun start(c: Context) { ContextCompat.startForegroundService(c, Intent(c, DriveService::class.java)) }
    fun stop(c: Context) { c.stopService(Intent(c, DriveService::class.java)) }
  }
}
