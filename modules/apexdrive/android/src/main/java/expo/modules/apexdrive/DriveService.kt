package expo.modules.apexdrive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
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
// 5 dk hareketsiz kalınca kaydı bitirir ama servisi kapatmaz: düşük güçle hareket bekler, hareket başlayınca yeni kayıt açar.
// (Google "araçta" durumundan çıkmadıysa yeni "girdi" olayı göndermez, o yüzden servis bu sürede açık kalmalı.)
// Araçtan inince ("çıktı" olayı) ya da 30 dk hareket olmazsa servis tamamen durur; dosyayı uygulama açılınca okur.
// Kullanıcı uygulamadan bitirirse de servis kapanmaz, hareket beklemeye geçer (Google hâlâ "araçta" diyorsa yeni "girdi" olayı gelmez).
class DriveService : Service() {
  private var client: FusedLocationProviderClient? = null
  private var out: FileWriter? = null
  private var lastMove = 0L
  private var pts = 0 // TEŞHİS
  private var bad = 0 // TEŞHİS
  private var waiting = false
  private var anchor: Location? = null
  private var waitSince = 0L

  private val callback = object : LocationCallback() {
    override fun onLocationResult(r: LocationResult) {
      val now = System.currentTimeMillis()
      if (waiting) {
        if (Store.prefs(this@DriveService).getBoolean("busy", false)) return // uygulama zaten sürüş kaydediyor
        for (l in r.locations) {
          val a = anchor
          if (a == null) { anchor = l; continue }
          // GPS sapmasını hareket sanmamak için mesafe, iki konumun belirsizliğinden büyük olmalı
          if ((l.hasSpeed() && l.speed > 2.5f) || l.distanceTo(a) > Math.max(120f, a.accuracy + l.accuracy)) {
            beginRecording()
            return
          }
        }
        if (now - waitSince > WAIT_MS) {
          Diag.add(this@DriveService, "30 dk hareket yok, servis durdu") // TEŞHİS
          stopSelf()
        }
        return
      }
      val w = out ?: return
      for (l in r.locations) {
        if (l.accuracy > 50f) { bad++; continue }
        val speed = if (l.hasSpeed()) l.speed else -1f
        val bearing = if (l.hasBearing()) l.bearing else -1f
        w.write("${l.time},${l.latitude},${l.longitude},$speed,${l.accuracy},$bearing\n")
        pts++
        if (pts == 1) Diag.add(this@DriveService, "ilk nokta alindi") // TEŞHİS
        if (speed > 1.5f) lastMove = now
      }
      w.flush()
      if (now - lastMove > IDLE_MS) startWaiting()
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_FINISH) { // kullanıcı uygulamadan bitirdi: kayıt biter ama servis hareket beklemeye geçer
      if (client == null) { stopSelf(); return START_NOT_STICKY }
      if (!waiting) startWaiting()
      return START_STICKY
    }
    goForeground()
    if (client == null) {
      client = LocationServices.getFusedLocationProviderClient(this)
      beginRecording()
    } else if (waiting) {
      beginRecording() // "araçta" olayı geldi: bekleme biter, kayıt başlar
    }
    return START_STICKY
  }

  // Yeni kayıt başlatır (süren yakın tarihli kayıt varsa ona devam eder)
  private fun beginRecording() {
    val p = Store.prefs(this)
    var name = Store.activeName(this)
    if (name.isEmpty()) name = "trip_${System.currentTimeMillis()}_${p.getString("veh", "v0")}.jsonl"
    p.edit().putString("cur", name).putBoolean("rec", true).apply()
    try { out?.close() } catch (e: Exception) {}
    out = FileWriter(File(Store.dir(this), name), true)
    waiting = false
    anchor = null
    pts = 0
    bad = 0
    lastMove = System.currentTimeMillis()
    Diag.add(this, "kayit basladi") // TEŞHİS
    goForeground()
    requestUpdates(true)
  }

  // Kaydı bitirir, servisi açık tutup düşük güçle hareket bekler
  private fun startWaiting() {
    try { out?.close() } catch (e: Exception) {}
    out = null
    Store.prefs(this).edit().putBoolean("rec", false).apply()
    Diag.add(this, "5 dk hareketsiz, kayit bitti, hareket bekleniyor: " + pts + " nokta, " + bad + " zayif konum atildi") // TEŞHİS
    waiting = true
    anchor = null
    waitSince = System.currentTimeMillis()
    goForeground()
    requestUpdates(false)
  }

  private fun requestUpdates(high: Boolean) {
    val req = if (high) {
      LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000L).setMinUpdateIntervalMillis(1000L).build()
    } else {
      LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 5000L).setMinUpdateIntervalMillis(3000L).build()
    }
    try {
      client?.requestLocationUpdates(req, callback, Looper.getMainLooper())
    } catch (e: SecurityException) {
      Diag.add(this, "konum izni yok, servis durdu") // TEŞHİS
      stopSelf()
    }
  }

  private fun goForeground() {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CH, "Sürüş kaydı", NotificationManager.IMPORTANCE_LOW))
    val icon = resources.getIdentifier("notification_icon", "drawable", packageName).takeIf { it != 0 } ?: applicationInfo.icon
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE) }
    val n = NotificationCompat.Builder(this, CH)
      .setSmallIcon(icon)
      .setContentTitle("ApexDrive")
      .setContentText(if (waiting) "Sürüş bekleniyor" else "Sürüşün kaydediliyor")
      .setOngoing(true)
      .setContentIntent(open)
      .build()
    if (Build.VERSION.SDK_INT >= 29) startForeground(NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION) else startForeground(NID, n)
  }

  override fun onDestroy() {
    Diag.add(this, "servis durdu: " + pts + " nokta, " + bad + " zayif konum atildi") // TEŞHİS
    client?.removeLocationUpdates(callback)
    client = null
    try { out?.close() } catch (e: Exception) {}
    out = null
    Store.prefs(this).edit().putBoolean("rec", false).apply()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    const val ACTION_FINISH = "expo.modules.apexdrive.FINISH"
    private const val CH = "apexdrive_drive"
    private const val NID = 4107
    private const val IDLE_MS = 300000L
    private const val WAIT_MS = 1800000L
    fun start(c: Context) { ContextCompat.startForegroundService(c, Intent(c, DriveService::class.java)) }
    fun stop(c: Context) { c.stopService(Intent(c, DriveService::class.java)) }
  }
}
