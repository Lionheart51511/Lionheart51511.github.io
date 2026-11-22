// scrape.mjs — الجلب التلقائي لفئات المستثمرين من موقع البورصة المصرية.
// يعمل بمتصفح Chromium حقيقي (Playwright) لأن موقع البورصة
// يرفض أي طلبات غير قادمة من متصفح فعلي.
//
// ماذا يفعل؟
// 1) يحسب تاريخ ووقت القاهرة الآن (Africa/Cairo).
// 2) خارج وضع force: يخرج بهدوء ما لم يكن اليوم أحد–خميس والوقت
//    بين 10:00 و15:00، وزمن الصف هو ربع الساعة الحالي مضبوطاً
//    بين 10:00 و14:30.
// 3) يفتح صفحة فئات المستثمرين، يختار «الأسهم فقط»، ويقرأ جدولي
//    الأفراد والمؤسسات (تنبيه: عمود البيع يسبق عمود الشراء في
//    ترتيب أعمدة الصفحة).
// 4) يرسل الصف JSON إلى تطبيق الويب المستقبِل في الشيت.
//
// تنبيه: صفحة البورصة تعيد تحميل نفسها بعد الفتح الأول أحياناً،
// فكل خطوات القراءة هنا مبنية على انتظار الاستقرار وإعادة
// المحاولة عند خطأ «Execution context was destroyed» بدل أن
// تنهار التشغيلة من أول تنقّل.

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

var EGX_URL = 'https://www.egx.com.eg/ar/InvestorsTypePieChart.aspx';
var WEBAPP_URL = process.env.WEBAPP_URL || '';
var POST_TOKEN = process.env.POST_TOKEN || '';
var FORCE = process.env.FORCE === 'true';

function cairoNow() {
  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short'
  });
  var parts = {};
  var list = fmt.formatToParts(new Date());
  for (var i = 0; i < list.length; i++) parts[list[i].type] = list[i].value;
  var weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  var hour = parts.hour === '24' ? 0 : Number(parts.hour);
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    weekday: weekdayMap[parts.weekday],
    minutes: hour * 60 + Number(parts.minute)
  };
}

function toHHMM(mins) {
  var h = String(Math.floor(mins / 60));
  var m = String(mins % 60);
  return (h.length < 2 ? '0' + h : h) + ':' + (m.length < 2 ? '0' + m : m);
}

function floorQuarter(mins) {
  return mins - (mins % 15);
}

async function saveDebugAndExit(page, err) {
  console.error('FAILED: ' + (err && err.message ? err.message : String(err)));
  if (page) {
    try { await page.screenshot({ path: 'egx-debug.png', fullPage: true }); } catch (e) {}
    try { await writeFile('egx-debug.html', await page.content(), 'utf8'); } catch (e) {}
  }
  process.exit(1);
}

// صفحة البورصة تعيد تحميل/توجيه نفسها بعد الفتح الأول أحياناً،
// فيُدمَّر سياق التنفيذ ويرمي Playwright خطأ
// «Execution context was destroyed». الدوال التالية تجعل كل خطوة
// قراءة تتحمل هذا التنقّل وتعيد المحاولة حتى تستقر الصفحة، بدل
// أن تنهار التشغيلة كلها من أول تنقّل.
function isNavError(err) {
  var m = err && err.message ? err.message : String(err || '');
  return m.indexOf('Execution context was destroyed') >= 0 ||
    m.toLowerCase().indexOf('navigation') >= 0;
}

// حلقة استقرار حتى 30 ثانية بعد فتح الصفحة: انتظار هدوء الشبكة
// بمهلة متسامحة، ثم جسّ خفيف للصفحة (قراءة عنوانها)؛ إن رمى الجسّ
// خطأ تدمير السياق نكرر الانتظار والمحاولة حتى تستقر الصفحة.
async function waitForPageStable(page) {
  var deadline = Date.now() + 30000;
  var lastErr = null;
  while (Date.now() < deadline) {
    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(function () {});
      await page.evaluate(function () { return document.title; });
      return;
    } catch (err) {
      lastErr = err;
      if (!isNavError(err)) throw err;
      console.log('الصفحة أعادت تحميل نفسها — انتظار الاستقرار…');
      await page.waitForTimeout(1000);
    }
  }
  throw lastErr || new Error('لم تستقر صفحة البورصة خلال 30 ثانية');
}

// انتظار ظهور جداول البيانات بمحاولات متكررة تتحمل تدمير السياق:
// حتى 10 محاولات بفاصل ثانية، وتنجح المحاولة متى وُجدت «قيمة
// الشراء» (بصورتها المطبّعة «قيمه الشراء») أو عنوانا الجدولين
// في نص الصفحة.
async function waitForTables(page) {
  var lastErr = null;
  for (var attempt = 1; attempt <= 10; attempt++) {
    try {
      var found = await page.evaluate(function () {
        function norm(s) {
          return (s || '')
            .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي')
            .replace(/ة/g, 'ه').replace(/ؤ/g, 'و')
            .replace(/\s+/g, ' ').trim();
        }
        var text = norm(document.body ? document.body.innerText : '');
        if (text.indexOf('قيمه الشراء') >= 0) return true;
        return text.indexOf('الافراد حسب الجنسيه') >= 0 &&
          text.indexOf('الموسسات حسب الجنسيه') >= 0;
      });
      if (found) return;
      lastErr = null;
    } catch (err) {
      lastErr = err;
      if (!isNavError(err)) throw err;
    }
    if (attempt < 10) await page.waitForTimeout(1000);
  }
  if (lastErr) throw lastErr;
  throw new Error('لم تظهر جداول البيانات في صفحة البورصة');
}

// الاستخراج مع إعادة المحاولة حتى 5 مرات: عند أي خطأ تنقّل ننتظر
// اكتمال التحميل وثانيتين ثم نعيد الاستخراج من الصفر. ولا ينجح
// الاستخراج إلا إذا أعاد فعلياً 12 رقماً مكتملة.
async function extractWithRetry(page, extractFn) {
  var lastErr = null;
  for (var attempt = 1; attempt <= 5; attempt++) {
    try {
      var values = await extractFn();
      var keys = Object.keys(values || {});
      var complete = keys.length === 12 && keys.every(function (k) {
        return typeof values[k] === 'number' && isFinite(values[k]);
      });
      if (!complete) throw new Error('الاستخراج لم يُرجع 12 رقماً مكتملة من جدولي البورصة');
      return values;
    } catch (err) {
      lastErr = err;
      if (!isNavError(err) || attempt === 5) throw err;
      console.log('تدمّر سياق التنفيذ أثناء الاستخراج — إعادة المحاولة ' + (attempt + 1) + ' من 5…');
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(function () {});
      await page.waitForTimeout(2000);
    }
  }
  throw lastErr || new Error('فشل استخراج القيم من صفحة البورصة');
}

async function main() {
  if (!WEBAPP_URL || !POST_TOKEN) {
    console.error('أسرار GitHub ناقصة: تأكد من وجود WEBAPP_URL و POST_TOKEN في إعدادات المستودع.');
    process.exit(1);
  }

  var now = cairoNow();
  var slotMinutes;
  if (FORCE) {
    // وضع الاختبار اليدوي: يتجاوز حارس النافذة ويستخدم تاريخ اليوم
    // وربع الساعة الحالي بتوقيت القاهرة كما هو.
    slotMinutes = floorQuarter(now.minutes);
    console.log('FORCE mode: Cairo ' + now.date + ' slot ' + toHHMM(slotMinutes));
  } else {
    var isTradingDay = now.weekday >= 0 && now.weekday <= 4; // الأحد=0 .. الخميس=4
    if (!isTradingDay || now.minutes < 10 * 60 || now.minutes > 15 * 60) {
      console.log('خارج جلسة التداول بتوقيت القاهرة — لا شيء يُجلب.');
      return;
    }
    slotMinutes = Math.min(Math.max(floorQuarter(now.minutes), 10 * 60), 14 * 60 + 30);
  }
  var slotTime = toHHMM(slotMinutes);

  var browser = await chromium.launch();
  var page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  try {
    await page.goto(EGX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // الصفحة قد تعيد تحميل نفسها بعد الفتح الأول — ننتظر استقرارها
    await waitForPageStable(page);

    // التحميل الأول قد يرجع صفحة بيضاء أحياناً — إعادة تحميل واحدة
    var bodyText = await page.evaluate(function () {
      return document.body ? document.body.innerText : '';
    });
    if (!bodyText || bodyText.trim().length < 50) {
      console.log('الصفحة فارغة — إعادة التحميل مرة واحدة…');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitForPageStable(page);
    }

    await waitForTables(page);

    // الضغط على راديو «الأسهم فقط» مقترناً بانتظار التنقّل الذي
    // يسببه الضغط (يعيد تحميل الصفحة بنفس الرابط). انتظار التنقّل
    // متسامح: إن حدث التنقّل أصلاً قبل الضغط، أو تدمّر السياق
    // أثناء الضغط نفسه، نكمل ونعتمد على انتظار الاستقرار
    // والجداول الذي يلي الضغط.
    var clickOutcome = await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 })
        .then(function () { return 'navigated'; })
        .catch(function () { return 'no-navigation'; }),
      page.evaluate(function () {
      function norm(s) {
        return (s || '')
          .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي')
          .replace(/ة/g, 'ه').replace(/ؤ/g, 'و')
          .replace(/\s+/g, ' ').trim();
      }
      var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
      var i, lab, radios, r;
      for (i = 0; i < labels.length; i++) {
        if (norm(labels[i].textContent) === 'الاسهم فقط') { labels[i].click(); return true; }
      }
      radios = Array.prototype.slice.call(document.querySelectorAll('input[type="radio"]'));
      for (i = 0; i < radios.length; i++) {
        r = radios[i];
        lab = r.id ? document.querySelector('label[for="' + r.id + '"]') : null;
        if (lab && norm(lab.textContent) === 'الاسهم فقط') { r.click(); return true; }
      }
      return false;
      }).catch(function (err) {
        if (isNavError(err)) return 'nav-during-click';
        throw err;
      })
    ]);
    if (clickOutcome[1] === false) throw new Error('لم يتم العثور على اختيار «الأسهم فقط» في صفحة البورصة');

    await waitForPageStable(page);
    await waitForTables(page);

    // إن تدمّر السياق أثناء الضغط نفسه فقد لا تكون الضغطة سُجّلت —
    // تحقق أن «الأسهم فقط» مفعّل فعلاً، وكرر الضغط عند الحاجة.
    var stocksChecked = await page.evaluate(function () {
      function norm(s) {
        return (s || '')
          .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي')
          .replace(/ة/g, 'ه').replace(/ؤ/g, 'و')
          .replace(/\s+/g, ' ').trim();
      }
      var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
      for (var i = 0; i < labels.length; i++) {
        if (norm(labels[i].textContent) === 'الاسهم فقط') {
          var input = labels[i].querySelector('input[type="radio"]');
          if (!input && labels[i].htmlFor) input = document.getElementById(labels[i].htmlFor);
          return input ? !!input.checked : true;
        }
      }
      return true;
    }).catch(function () { return true; });
    if (!stocksChecked) {
      await page.evaluate(function () {
        function norm(s) {
          return (s || '')
            .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي')
            .replace(/ة/g, 'ه').replace(/ؤ/g, 'و')
            .replace(/\s+/g, ' ').trim();
        }
        var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
        for (var i = 0; i < labels.length; i++) {
          if (norm(labels[i].textContent) === 'الاسهم فقط') { labels[i].click(); return true; }
        }
        return false;
      }).catch(function () { return false; });
      await waitForPageStable(page);
      await waitForTables(page);
    }

    // استخراج القيم من جدولي الأفراد والمؤسسات — ملفوفاً في إعادة
    // محاولة تتحمل تدمير سياق التنفيذ، ولا ينجح إلا بـ 12 رقماً
    var extractOnce = function () {
      return page.evaluate(function () {
      function norm(s) {
        return (s || '')
          .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي')
          .replace(/ة/g, 'ه').replace(/ؤ/g, 'و')
          .replace(/\s+/g, ' ').trim();
      }
      function cleanNum(s) {
        var n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, ''));
        return isFinite(n) ? n : 0;
      }
      function tableTitle(table) {
        var el = table.previousElementSibling;
        while (el) {
          var t = norm(el.textContent);
          if (t) return t;
          el = el.previousElementSibling;
        }
        var cap = table.querySelector('caption');
        return cap ? norm(cap.textContent) : '';
      }
      var tables = Array.prototype.slice.call(document.querySelectorAll('table'));
      var indTable = null, instTable = null, i, title;
      for (i = 0; i < tables.length; i++) {
        title = tableTitle(tables[i]);
        if (title.indexOf('الافراد حسب الجنسيه') >= 0) indTable = tables[i];
        if (title.indexOf('الموسسات حسب الجنسيه') >= 0) instTable = tables[i];
      }
      if (!indTable || !instTable) {
        // احتياطي: ترتيب الجدولين بين الجداول ذات رأس «قيمة الشراء»
        // (الجدول الأول بينها إجمالي بلا عنوان ويُتجاهل إن وُجدت 3)
        var withBuy = tables.filter(function (t) {
          return norm(t.textContent).indexOf('قيمة الشراء') >= 0;
        });
        if (withBuy.length >= 3) { indTable = withBuy[1]; instTable = withBuy[2]; }
        else if (withBuy.length === 2) { indTable = withBuy[0]; instTable = withBuy[1]; }
      }
      if (!indTable || !instTable) {
        throw new Error('لم يتم العثور على جدولي الأفراد والمؤسسات في الصفحة');
      }
      function readRows(table) {
        // ترتيب الأعمدة في الصفحة: [الجنسية، قيمة البيع، قيمة الشراء، صافي القيمة]
        // تنبيه: البيع يأتي قبل الشراء!
        var out = {};
        var rows = Array.prototype.slice.call(table.querySelectorAll('tr'));
        for (var r = 0; r < rows.length; r++) {
          var cells = Array.prototype.slice.call(rows[r].querySelectorAll('td, th'))
            .map(function (c) { return c.textContent; });
          if (cells.length < 3) continue;
          var name = norm(cells[0]);
          if (name === 'مصريين' || name === 'عرب' || name === 'اجانب') {
            out[name] = { sell: cleanNum(cells[1]), buy: cleanNum(cells[2]) };
          }
        }
        return out;
      }
      var ind = readRows(indTable);
      var inst = readRows(instTable);
      function need(obj, name) {
        if (!obj[name]) throw new Error('صف مفقود في أحد الجداول: ' + name);
        return obj[name];
      }
      var egI = need(ind, 'مصريين'), arI = need(ind, 'عرب'), foI = need(ind, 'اجانب');
      var egS = need(inst, 'مصريين'), arS = need(inst, 'عرب'), foS = need(inst, 'اجانب');
      return {
        eg_ind_buy: egI.buy, eg_ind_sell: egI.sell,
        eg_inst_buy: egS.buy, eg_inst_sell: egS.sell,
        ar_ind_buy: arI.buy, ar_ind_sell: arI.sell,
        ar_inst_buy: arS.buy, ar_inst_sell: arS.sell,
        fo_ind_buy: foI.buy, fo_ind_sell: foI.sell,
        fo_inst_buy: foS.buy, fo_inst_sell: foS.sell
      };
      });
    };
    var values = await extractWithRetry(page, extractOnce);

    await browser.close();
    console.log('EGX values for ' + now.date + ' ' + slotTime + ': ' + JSON.stringify(values));

    // الإرسال إلى المستقبِل في الشيت والتحقق من رده
    var res = await fetch(WEBAPP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: POST_TOKEN, date: now.date, time: slotTime, values: values })
    });
    var text = await res.text();
    var data = null;
    try { data = JSON.parse(text); } catch (e) {}
    if (!data || data.ok !== true) {
      throw new Error('رفض المستقبِل البيانات أو رد بشكل غير متوقع: ' + text.slice(0, 200));
    }
    console.log('تمت كتابة الصف في الشيت بنجاح: ' + now.date + ' ' + slotTime + ' (' + (data.action || 'ok') + ')');
  } catch (err) {
    await saveDebugAndExit(page, err);
  }
}

main().catch(function (err) {
  console.error('FAILED: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
