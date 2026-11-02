// Завдання тренажера. Кожне: етап циклу ІАЗ, наказ, еталонний селектор,
// довідка з синтаксису, доктринальна вставка та розмітка обстановки.
// Відповідь гравця зараховується, якщо вона відбирає РІВНО ті самі елементи, що й selector.

window.STAGES = [
  'ЕТАП I · ЗБІР ТА ОБЛІК',
  'ЕТАП II · КЛАСИФІКАЦІЯ',
  'ЕТАП III · ОЦІНКА ДОСТОВІРНОСТІ',
  'ЕТАП IV · АНАЛІЗ І КОРЕЛЯЦІЯ',
  'ЕТАП V · УЗАГАЛЬНЕННЯ ТА ДОВЕДЕННЯ'
];

window.LEVELS = [
  // ───────────── ЕТАП I ─────────────
  {
    stage: 0,
    title: 'Облік донесень',
    order: 'На КП надходять дані з різних джерел. Візьміть на облік <b>усі донесення</b>.',
    selector: 'report',
    syntaxName: 'Селектор типу',
    syntax: 'ТИП',
    syntaxDesc: 'Відбирає всі елементи вказаного типу. У журналі обстановки тип — це слово після <code>&lt;</code>.',
    examples: [['report', 'усі донесення'], ['target', 'усі цілі']],
    doctrine: {
      title: 'Що таке ІАЗ',
      body: `<p><b>Інформаційно-аналітичне забезпечення</b> — комплекс заходів зі збору, обробки, аналізу, узагальнення та своєчасного доведення інформації до командира й органів управління для підготовки та ухвалення рішень.</p>
<ol><li>Планування збору</li><li>Збір</li><li>Обробка</li><li>Аналіз і узагальнення</li><li>Доведення</li></ol>
<p>Робота починається з обліку: жодне донесення, що надійшло на КП, не повинно лишитися незареєстрованим.</p>`
    },
    hint: 'Донесення в розмітці мають тип <code>report</code>.',
    markup: `
<report class="humint"></report>
<target class="tank"></target>
<report class="sigint"></report>
<target class="artillery"></target>
<report class="osint"></report>`
  },
  {
    stage: 0,
    title: 'Нанесення цілей',
    order: 'Нанесіть на робочу карту всі виявлені <b>цілі</b>.',
    selector: 'target',
    syntaxName: 'Селектор типу',
    syntax: 'ТИП',
    syntaxDesc: 'Той самий прийом, інший тип елемента.',
    examples: [['target', 'усі цілі'], ['sector', 'усі сектори']],
    doctrine: {
      title: 'Дані ≠ ціль',
      body: `<p><b>Донесення</b> — носій відомостей. <b>Ціль</b> — об'єкт противника, щодо якого ухвалюють рішення: спостерігати, уразити, обійти.</p>
<p>Аналітик розділяє ці сутності: одна ціль може мати багато донесень, а одне донесення — стосуватися кількох цілей.</p>`
    },
    hint: 'Тип цілей — <code>target</code>.',
    markup: `
<target class="tank"></target>
<report class="imint"></report>
<target class="infantry"></target>
<target class="mlrs"></target>
<report class="humint"></report>`
  },
  {
    stage: 0,
    title: 'Журнал обліку',
    order: 'Начальник штабу вимагає з журналу обліку <b>донесення № 117</b>.',
    selector: '#r-117',
    syntaxName: 'Селектор ідентифікатора',
    syntax: '#id',
    syntaxDesc: 'Відбирає елемент з атрибутом <code>id</code>. Ідентифікатор унікальний — як реєстраційний номер.',
    examples: [['#r-115', 'донесення з id="r-115"'], ['#north', 'сектор з id="north"']],
    doctrine: {
      title: 'Реєстрація вхідних даних',
      body: `<p>Кожне вхідне донесення реєструють під унікальним номером. Разом з номером фіксують час надходження, джерело та виконавця.</p>
<p>Це забезпечує контроль виконання і дає змогу будь-коли повернутися до першоджерела, щоб перепровірити висновок.</p>`
    },
    hint: 'Номер 117 записаний в атрибуті <code>id="r-117"</code>.',
    markup: `
<report id="r-115" class="osint"></report>
<report id="r-116" class="humint"></report>
<report id="r-117" class="sigint"></report>
<report id="r-118" class="imint"></report>`
  },
  {
    stage: 0,
    title: 'Смуга відповідальності',
    order: 'Бригада відповідає лише за сектор <b>«ПІВНІЧ»</b>. Позначте цілі саме в ньому.',
    selector: '#north target',
    syntaxName: 'Селектор нащадка',
    syntax: 'A  B',
    syntaxDesc: 'Пробіл означає «всередині». Відбирає елементи B, що містяться (на будь-якій глибині) в елементі A.',
    examples: [['#north target', 'цілі в секторі «Північ»'], ['#south report', 'донесення в секторі «Південь»']],
    doctrine: {
      title: 'Смуга відповідальності та район інтересів',
      body: `<p>Аналітик зосереджує зусилля на <b>смузі відповідальності</b> свого підрозділу, але відстежує і <b>район інформаційних інтересів</b> — суміжні ділянки, звідки може прийти загроза з флангу.</p>
<p>Чітке розмежування не дає дублювати роботу сусідів і втрачати дані на стиках.</p>`
    },
    hint: 'Сектор має <code>id="north"</code>. Спершу сектор, пробіл, потім тип.',
    markup: `
<sector id="north">
  <target class="tank"></target>
  <report class="sigint"></report>
  <target class="artillery"></target>
</sector>
<sector id="south">
  <target class="tank"></target>
  <target class="cp"></target>
</sector>`
  },

  // ───────────── ЕТАП II ─────────────
  {
    stage: 1,
    title: 'Вид розвідки',
    order: 'Начальник радіоелектронної розвідки просить усі дані <b>SIGINT</b>.',
    selector: '.sigint',
    syntaxName: 'Селектор класу',
    syntax: '.клас',
    syntaxDesc: 'Відбирає всі елементи з указаним значенням в атрибуті <code>class</code>. У донесень клас — це вид розвідки.',
    examples: [['.humint', 'агентурні донесення'], ['.osint', 'дані з відкритих джерел']],
    doctrine: {
      title: 'Види розвідки',
      body: `<table class="doc-table">
<tr><td>HUMINT</td><td>агентурна: людські джерела, полонені, місцеве населення</td></tr>
<tr><td>SIGINT</td><td>радіоелектронна: перехоплення зв'язку, пеленгування випромінювань</td></tr>
<tr><td>IMINT</td><td>видова: аеро- й космічні знімки, відео з БпЛА</td></tr>
<tr><td>OSINT</td><td>відкриті джерела: соцмережі, ЗМІ, публічні дані</td></tr></table>
<p>Кожен вид має сильні та слабкі сторони, тому аналітик поєднує їх.</p>`
    },
    hint: 'Клас пишеться з крапкою: <code>.назва</code>.',
    markup: `
<sector id="west">
  <report class="humint"></report>
  <report class="sigint"></report>
  <report class="imint"></report>
</sector>
<sector id="east">
  <report class="sigint"></report>
  <report class="osint"></report>
  <report class="sigint"></report>
</sector>`
  },
  {
    stage: 1,
    title: 'Пріоритетні потреби',
    order: 'PIR командира: «Де артилерія противника?». Позначте лише <b>цілі-артилерію</b> — теку зі справою не чіпайте.',
    selector: 'target.artillery',
    syntaxName: 'Тип + клас',
    syntax: 'ТИП.клас',
    syntaxDesc: 'Записані разом без пробілу: елемент має бути цього типу <i>і</i> мати цей клас.',
    examples: [['target.tank', 'цілі-танки'], ['report.imint', 'донесення видової розвідки']],
    doctrine: {
      title: 'PIR — пріоритетні інформаційні потреби',
      body: `<p><b>PIR</b> — питання командира, відповідь на які критично потрібна для ухвалення рішення.</p>
<p>Усі зусилля збору й аналізу підпорядковуються PIR. Решта — другорядна і не повинна відволікати ресурси.</p>`
    },
    hint: 'Клас <code>.artillery</code> мають і цілі, і тека. Додайте тип перед крапкою.',
    markup: `
<dossier class="artillery">
  <report class="humint"></report>
</dossier>
<target class="artillery"></target>
<target class="tank"></target>
<target class="artillery"></target>
<target class="ad"></target>`
  },
  {
    stage: 1,
    title: 'Вибірка під споживача',
    order: 'Підрозділ ударних БпЛА планує маршрути. Потрібні всі засоби <b>ППО та РЕБ</b> противника.',
    selector: '.ad, .ew',
    syntaxName: 'Об\'єднання',
    syntax: 'A, B',
    syntaxDesc: 'Кома об\'єднує кілька селекторів: відбирається все, що відповідає хоча б одному з них.',
    examples: [['.humint, .osint', 'агентурні та відкриті'], ['target, report', 'усі цілі й донесення']],
    doctrine: {
      title: 'Інформаційний продукт під конкретного споживача',
      body: `<p>Різні споживачі потребують різних зрізів обстановки: пілотам БпЛА — ППО і РЕБ, артилерії — координати вогневих засобів, логістам — стан маршрутів.</p>
<p>Аналітик не віддає «все підряд», а формує вибірку під завдання конкретного споживача.</p>`
    },
    hint: 'ППО — клас <code>.ad</code>, РЕБ — <code>.ew</code>. З\'єднайте їх комою.',
    markup: `
<sector id="north">
  <target class="ad"></target>
  <target class="tank"></target>
  <target class="ew"></target>
</sector>
<sector id="east">
  <target class="ew"></target>
  <target class="logistics"></target>
  <target class="infantry"></target>
</sector>`
  },
  {
    stage: 1,
    title: 'Передача смуги',
    order: 'Сектор <b>«ПІВДЕНЬ»</b> передається суміжній бригаді. Передайте <b>все</b>, що в ньому є, — включно з вкладеними донесеннями.',
    selector: '#south *',
    syntaxName: 'Універсальний селектор',
    syntax: '*',
    syntaxDesc: 'Зірочка відповідає будь-якому елементу. У поєднанні з нащадком — «все всередині».',
    examples: [['*', 'усе на карті'], ['#east *', 'усе в секторі «Схід»']],
    doctrine: {
      title: 'Взаємодія та обмін інформацією',
      body: `<p>ІАЗ — не лише «вгору» командиру: дані обмінюються з вищим штабом, підлеглими та сусідами.</p>
<p>Під час передачі смуги передається <b>вся</b> накопичена обстановка, щоб нова частина не починала з нуля і не втратила вже виявлені цілі.</p>`
    },
    hint: 'Сектор <code>#south</code>, пробіл, зірочка.',
    markup: `
<sector id="center">
  <target class="infantry"></target>
  <report class="osint"></report>
</sector>
<sector id="south">
  <target class="mlrs">
    <report class="imint"></report>
  </target>
  <report class="humint"></report>
  <target class="logistics"></target>
</sector>`
  },

  // ───────────── ЕТАП III ─────────────
  {
    stage: 2,
    title: 'Первинна обробка',
    order: 'Відберіть донесення, що вже пройшли перевірку — мають позначку <b>verified</b>.',
    selector: '[verified]',
    syntaxName: 'Наявність атрибута',
    syntax: '[атрибут]',
    syntaxDesc: 'Відбирає елементи, що мають атрибут з такою назвою — незалежно від значення.',
    examples: [['[verified]', 'з позначкою перевірки'], ['report[id]', 'донесення з реєстраційним номером']],
    doctrine: {
      title: 'Обробка інформації',
      body: `<p>Первинна обробка: реєстрація, переклад, приведення до єдиного формату, відсіювання повторів, нанесення на карту, перевірка.</p>
<p>Перевірені дані позначають, щоб не витрачати час на повторну перевірку і щоб споживач бачив, на що можна спиратися.</p>`
    },
    hint: 'Назву атрибута візьміть у квадратні дужки.',
    markup: `
<report class="humint" verified></report>
<report class="osint"></report>
<report class="sigint" verified></report>
<report class="osint"></report>
<report class="imint" verified></report>`
  },
  {
    stage: 2,
    title: 'Надійність джерела',
    order: 'Для доповіді командиру потрібні дані лише від <b>цілком надійних джерел</b> — оцінка «A».',
    selector: '[rel="A"]',
    syntaxName: 'Значення атрибута',
    syntax: '[атрибут="значення"]',
    syntaxDesc: 'Відбирає елементи, у яких атрибут має саме це значення. Атрибут <code>rel</code> — надійність джерела.',
    examples: [['[rel="B"]', 'зазвичай надійні джерела'], ['[prio="routine"]', 'звичайна терміновість']],
    doctrine: {
      title: 'Адміралтейська система: надійність джерела',
      body: `<table class="doc-table">
<tr><td>A</td><td>цілком надійне</td></tr><tr><td>B</td><td>зазвичай надійне</td></tr>
<tr><td>C</td><td>досить надійне</td></tr><tr><td>D</td><td>не завжди надійне</td></tr>
<tr><td>E</td><td>ненадійне</td></tr><tr><td>F</td><td>надійність неможливо оцінити</td></tr></table>
<p>Літера оцінює <b>джерело</b> (його попередню історію), а не конкретне повідомлення. Система закріплена в стандартах НАТО (STANAG 2511).</p>`
    },
    hint: 'Значення в лапках: <code>[rel="…"]</code>.',
    markup: `
<report class="humint" rel="C"></report>
<report class="sigint" rel="A"></report>
<report class="osint" rel="F"></report>
<report class="imint" rel="A"></report>
<report class="humint" rel="B"></report>`
  },
  {
    stage: 2,
    title: 'Ознаки дезінформації',
    order: 'Противник проводить ІПСО. Виявіть донесення з вірогідністю <b>«5»</b> — ймовірна дезінформація.',
    selector: '[cred="5"]',
    syntaxName: 'Значення атрибута',
    syntax: '[атрибут="значення"]',
    syntaxDesc: 'Атрибут <code>cred</code> — вірогідність самої інформації (цифра в оцінці).',
    examples: [['[cred="1"]', 'підтверджені дані'], ['[cred="6"]', 'вірогідність не визначена']],
    doctrine: {
      title: 'Адміралтейська система: вірогідність інформації',
      body: `<table class="doc-table">
<tr><td>1</td><td>підтверджена іншими джерелами</td></tr><tr><td>2</td><td>ймовірно правдива</td></tr>
<tr><td>3</td><td>можливо правдива</td></tr><tr><td>4</td><td>сумнівна</td></tr>
<tr><td>5</td><td>неймовірна</td></tr><tr><td>6</td><td>правдивість неможливо оцінити</td></tr></table>
<p>Цифра оцінюється <b>незалежно</b> від літери: навіть надійне джерело може передати хибні дані, а ненадійне — правдиві.</p>`
    },
    hint: 'Атрибут вірогідності — <code>cred</code>.',
    markup: `
<report class="osint" rel="F" cred="5"></report>
<report class="humint" rel="B" cred="2"></report>
<report class="osint" rel="E" cred="5"></report>
<report class="sigint" rel="B" cred="3"></report>
<report class="humint" rel="D" cred="4"></report>`
  },
  {
    stage: 2,
    title: 'Фільтрація шуму',
    order: 'Передайте в обробку всі <b>донесення</b>, крім ймовірної дезінформації (вірогідність «5»).',
    selector: 'report:not([cred="5"])',
    syntaxName: 'Заперечення',
    syntax: ':not(X)',
    syntaxDesc: 'Відбирає елементи, що <i>не</i> відповідають селектору X. Найкраще поєднувати з типом.',
    examples: [['report:not(.osint)', 'усі донесення, крім OSINT'], ['target:not(.tank)', 'усі цілі, крім танків']],
    doctrine: {
      title: 'Відсіювання не означає знищення',
      body: `<p>КП отримує сотні повідомлень на добу; без фільтрації аналітик потоне в шумі.</p>
<p>Але відсіяну дезінформацію <b>зберігають окремо</b>: сама поява фейку — розвідознака, що вказує на задум противника і його цільову аудиторію.</p>`
    },
    hint: 'На карті є ціль — вона теж «не має cred=5». Обмежте вибір типом <code>report</code>.',
    markup: `
<report class="sigint" rel="B" cred="2"></report>
<report class="osint" rel="E" cred="5"></report>
<report class="imint" rel="A" cred="1"></report>
<report class="humint" rel="C" cred="5"></report>
<report class="osint" rel="C" cred="3"></report>
<target class="tank"></target>`
  },
  {
    stage: 2,
    title: 'Комплексна оцінка',
    order: 'Відберіть донесення з найвищою оцінкою <b>«A1»</b> — надійне джерело і підтверджена інформація.',
    selector: '[rel="A"][cred="1"]',
    syntaxName: 'Кілька умов',
    syntax: '[a="x"][b="y"]',
    syntaxDesc: 'Умови, записані підряд без пробілів, мають виконуватися <i>одночасно</i>.',
    examples: [['[rel="B"][cred="2"]', 'оцінка B2'], ['report.sigint[rel="A"]', 'SIGINT від надійного джерела']],
    doctrine: {
      title: 'Як читати оцінку',
      body: `<p>Оцінку записують двома символами: <b>B2</b> — «зазвичай надійне джерело, інформація ймовірно правдива». Це найпоширеніша робоча оцінка.</p>
<p><b>A1</b> трапляється рідко. <b>F6</b> не означає «неправда» — лише те, що оцінити поки неможливо, і потрібна перевірка.</p>`
    },
    hint: 'Дві умови в квадратних дужках, одна за одною, без пробілу.',
    markup: `
<report class="imint" rel="A" cred="1"></report>
<report class="sigint" rel="A" cred="2"></report>
<report class="humint" rel="B" cred="1"></report>
<report class="imint" rel="A" cred="1"></report>
<report class="osint" rel="C" cred="1"></report>`
  },

  // ───────────── ЕТАП IV ─────────────
  {
    stage: 3,
    title: 'Зведення даних',
    order: 'Знайдіть донесення в секторі <b>«СХІД»</b>, які ще <b>не прив\'язані</b> до жодної цілі — лежать безпосередньо в секторі.',
    selector: '#east > report',
    syntaxName: 'Прямий нащадок',
    syntax: 'A > B',
    syntaxDesc: 'Відбирає B, що лежать <i>безпосередньо</i> в A — на першому рівні вкладеності, а не глибше.',
    examples: [['target > report', 'донесення, прив\'язані до цілей'], ['#north > target', 'цілі першого рівня в секторі']],
    doctrine: {
      title: 'Зведення (fusion)',
      body: `<p>Обробка зводить розрізнені донесення до конкретних об'єктів. Донесення, прив'язане до цілі, стає частиною її «картки».</p>
<p>Неприв'язане донесення висить у черзі: його треба або прив'язати до відомої цілі, або завести нову.</p>`
    },
    hint: '<code>#east report</code> захопить і вкладені в цілі. Потрібен символ <code>&gt;</code>.',
    markup: `
<sector id="east">
  <target class="artillery">
    <report class="imint"></report>
    <report class="sigint"></report>
  </target>
  <report class="humint"></report>
  <target class="tank">
    <report class="osint"></report>
  </target>
  <report class="sigint"></report>
</sector>`
  },
  {
    stage: 3,
    title: 'Первинне донесення',
    order: 'Донесення в картці цілі розташовані за часом надходження. Виділіть <b>первинні</b> донесення по кожній цілі.',
    selector: 'report:first-child',
    syntaxName: 'Перший дочірній',
    syntax: ':first-child',
    syntaxDesc: 'Відбирає елемент, що стоїть першим серед своїх «братів» у батьківському елементі.',
    examples: [['target:first-child', 'перша ціль у кожному секторі'], ['report:first-child', 'перше донесення в кожній групі']],
    doctrine: {
      title: 'Своєчасність понад повноту',
      body: `<p>Первинне донесення — швидке і часто неповне: «Виявлено РСЗВ, уточнюю».</p>
<p>Принцип: <b>краще своєчасно неповне, ніж повне, але запізніле</b>. Наступні донесення уточнюють і доповнюють перше.</p>`
    },
    hint: 'Допишіть псевдоклас до типу: <code>report:…</code>.',
    markup: `
<sector id="north">
  <target class="mlrs">
    <report class="osint"></report>
    <report class="imint"></report>
    <report class="sigint"></report>
  </target>
  <target class="cp">
    <report class="humint"></report>
    <report class="sigint"></report>
  </target>
</sector>`
  },
  {
    stage: 3,
    title: 'Актуальний стан',
    order: 'Командиру — лише актуальний стан кожної <b>цілі</b>: останні донесення в картках цілей.',
    selector: 'target > report:last-child',
    syntaxName: 'Останній дочірній',
    syntax: ':last-child',
    syntaxDesc: 'Відбирає елемент, що стоїть останнім у своєму батьківському елементі.',
    examples: [['report:last-child', 'останнє донесення в кожній групі'], ['#west > :last-child', 'останній елемент сектора']],
    doctrine: {
      title: 'Цінність даних падає з часом',
      body: `<p>Обстановка змінюється щохвилини: колона, помічена годину тому, вже деінде.</p>
<p>Аналітик завжди вказує час отримання, спирається на найсвіжіші дані, а застарілі явно позначає.</p>`
    },
    hint: 'Донесення поза ціллю — теж «останнє» у своєму секторі. Уточніть: <code>target &gt; …</code>.',
    markup: `
<sector id="west">
  <target class="ad">
    <report class="imint"></report>
    <report class="humint"></report>
  </target>
  <target class="radar">
    <report class="sigint"></report>
    <report class="sigint"></report>
    <report class="imint"></report>
  </target>
  <report class="osint"></report>
</sector>`
  },
  {
    stage: 3,
    title: 'Одне джерело',
    order: 'Виявіть донесення, що є <b>єдиним</b> джерелом даних по своїй цілі. Такі цілі вважаються непідтвердженими.',
    selector: 'report:only-child',
    syntaxName: 'Єдиний дочірній',
    syntax: ':only-child',
    syntaxDesc: 'Відбирає елемент, у якого немає жодного «брата» в тому ж батьківському елементі.',
    examples: [['target:only-child', 'ціль — єдина в секторі'], ['report:only-child', 'донесення без підтвердження']],
    doctrine: {
      title: 'Принцип підтвердження',
      body: `<p>Ціль вважається достовірно встановленою, коли її підтверджують щонайменше <b>два незалежні джерела</b>, бажано різних видів розвідки.</p>
<p>Одне джерело — не підстава для удару, а привід для дорозвідки. Саме тому вірогідність «1» дають лише підтвердженим даним.</p>`
    },
    hint: 'Тип <code>report</code> плюс псевдоклас «єдиний дочірній».',
    markup: `
<sector id="center">
  <target class="artillery">
    <report class="humint"></report>
  </target>
  <target class="tank">
    <report class="imint"></report>
    <report class="sigint"></report>
  </target>
  <target class="logistics">
    <report class="osint"></report>
  </target>
</sector>`
  },
  {
    stage: 3,
    title: 'Перехресне наведення',
    order: 'Виділіть знімки (<b>IMINT</b>), що надійшли <b>одразу після</b> перехоплення (SIGINT), — вони його підтверджують.',
    selector: '.sigint + .imint',
    syntaxName: 'Сусідній наступний',
    syntax: 'A + B',
    syntaxDesc: 'Відбирає B, що стоїть <i>безпосередньо</i> після A в тому ж батьківському елементі.',
    examples: [['.humint + .osint', 'OSINT одразу після агентурного'], ['target + report', 'донесення одразу за ціллю']],
    doctrine: {
      title: 'Cross-cueing',
      body: `<p><b>Перехресне наведення</b>: один засіб розвідки виявляє ознаку (пеленг радіостанції), інший — перевіряє її (БпЛА знімає вказаний район).</p>
<p>Так із сигналу народжується підтверджена ціль. Кореляція даних різних видів розвідки — основа аналізу.</p>`
    },
    hint: 'Знімок, що йде першим у картці, не підходить — перед ним немає перехоплення.',
    markup: `
<target class="ew">
  <report class="sigint"></report>
  <report class="imint"></report>
  <report class="osint"></report>
</target>
<target class="cp">
  <report class="imint"></report>
  <report class="sigint"></report>
  <report class="imint"></report>
</target>`
  },
  {
    stage: 3,
    title: 'Оцінка результатів ураження',
    order: 'Цілі уражено. Для оцінки результатів (BDA) зберіть усі донесення, що надійшли <b>після удару</b>.',
    selector: 'fire ~ report',
    syntaxName: 'Усі наступні',
    syntax: 'A ~ B',
    syntaxDesc: 'Відбирає всі B, що стоять <i>після</i> A в тому ж батьківському елементі (не обов\'язково впритул).',
    examples: [['.sigint ~ report', 'усе, що надійшло після перехоплення'], ['fire ~ .imint', 'знімки після удару']],
    doctrine: {
      title: 'BDA — оцінка результатів ураження',
      body: `<p>Після удару аналітик встановлює: ціль знищено, пошкоджено чи вона вціліла або перемістилась.</p>
<p>Від висновку залежить, чи потрібен повторний удар. Основний інструмент — порівняння знімків «до» і «після».</p>`
    },
    hint: 'Удар — елемент <code>fire</code>. Потрібні всі донесення після нього: символ <code>~</code>.',
    markup: `
<target class="artillery">
  <report class="imint"></report>
  <fire></fire>
  <report class="imint"></report>
  <report class="osint"></report>
</target>
<target class="mlrs">
  <report class="sigint"></report>
  <report class="humint"></report>
  <fire></fire>
  <report class="imint"></report>
</target>`
  },
  {
    stage: 3,
    title: 'Прогалини в розвідданих',
    order: 'Знайдіть цілі, по яких немає <b>жодного</b> донесення, і передайте їх на дорозвідку.',
    selector: 'target:empty',
    syntaxName: 'Порожній елемент',
    syntax: ':empty',
    syntaxDesc: 'Відбирає елементи, всередині яких нічого немає.',
    examples: [['sector:empty', 'сектори без даних'], ['target:empty', 'цілі без донесень']],
    doctrine: {
      title: 'Цикл замикається',
      body: `<p>Виявлені прогалини стають новими завданнями на збір. ІАЗ — не конвеєр, а <b>цикл</b>: аналіз → нові питання → завдання розвідорганам → нові дані.</p>
<p>Уміння побачити, чого <i>не</i> знаєш, — така ж частина аналізу, як і робота з тим, що знаєш.</p>`
    },
    hint: 'Тип <code>target</code> плюс псевдоклас «порожній».',
    markup: `
<sector id="north">
  <target class="tank">
    <report class="imint"></report>
  </target>
  <target class="ad"></target>
</sector>
<sector id="south">
  <target class="radar"></target>
  <target class="cp">
    <report class="humint"></report>
    <report class="sigint"></report>
  </target>
  <target class="mlrs"></target>
</sector>`
  },

  // ───────────── ЕТАП V ─────────────
  {
    stage: 4,
    title: 'Терміновість доведення',
    order: 'Виявлено підготовку до удару. Виділіть донесення з терміновістю <b>FLASH</b> — вони йдуть командиру поза чергою.',
    selector: '[prio="flash"]',
    syntaxName: 'Значення атрибута',
    syntax: '[prio="…"]',
    syntaxDesc: 'Атрибут <code>prio</code> — категорія терміновості: <code>flash</code>, <code>immediate</code>, <code>priority</code>, <code>routine</code>.',
    examples: [['[prio="immediate"]', 'негайні'], ['#east [prio="routine"]', 'звичайні в секторі «Схід»']],
    doctrine: {
      title: 'Категорії терміновості',
      body: `<table class="doc-table">
<tr><td>FLASH</td><td>блискавична: загроза, що вимагає дій негайно</td></tr>
<tr><td>IMMEDIATE</td><td>негайна</td></tr><tr><td>PRIORITY</td><td>термінова</td></tr><tr><td>ROUTINE</td><td>звичайна</td></tr></table>
<p>Доведення — це <b>тому, кому потрібно, коли потрібно, у зручній формі</b>. Запізніла інформація втрачає цінність.</p>`
    },
    hint: 'Значення пишеться малими літерами: <code>flash</code>.',
    markup: `
<sector id="east">
  <report class="sigint" prio="routine"></report>
  <report class="imint" prio="flash"></report>
  <report class="humint" prio="priority"></report>
</sector>
<sector id="west">
  <report class="osint" prio="immediate"></report>
  <report class="sigint" prio="flash"></report>
</sector>`
  },
  {
    stage: 4,
    title: 'Захист від перевантаження',
    order: 'Противник закидає канали фейковими «терміновими» повідомленнями. Доведіть командиру лише <b>FLASH</b>-донесення, що <b>не</b> мають вірогідності «5».',
    selector: '[prio="flash"]:not([cred="5"])',
    syntaxName: 'Комбінування',
    syntax: '[…]:not(…)',
    syntaxDesc: 'Атрибути й псевдокласи можна ланцюжити: кожна наступна умова звужує вибір.',
    examples: [['.osint:not([rel="A"])', 'OSINT не від A-джерел'], ['[prio="flash"][rel="A"]', 'FLASH від надійних']],
    doctrine: {
      title: 'Інформаційне перевантаження як зброя',
      body: `<p>Масове вкидання фейкових «термінових» повідомлень паралізує штаб: усі зайняті перевіркою, справжній сигнал губиться.</p>
<p>Правило: <b>терміновість не скасовує оцінку достовірності</b>. Фільтр стоїть на вході, до доповіді.</p>`
    },
    hint: 'Почніть з <code>[prio="flash"]</code> і допишіть заперечення.',
    markup: `
<report class="osint" prio="flash" rel="E" cred="5"></report>
<report class="imint" prio="flash" rel="A" cred="1"></report>
<report class="humint" prio="routine" rel="B" cred="2"></report>
<report class="sigint" prio="flash" rel="B" cred="2"></report>
<report class="osint" prio="flash" rel="F" cred="5"></report>`
  },
  {
    stage: 4,
    title: 'Розвідувальний продукт',
    order: 'ФІНАЛ. Готується контрбатарейна боротьба. Підготуйте пакет: донесення про <b>артилерію</b> сектора <b>«СХІД»</b> від джерел з надійністю <b>A або B</b>.',
    selector: '#east .artillery [rel="A"], #east .artillery [rel="B"]',
    syntaxName: 'Усе разом',
    syntax: 'A B C, A B D',
    syntaxDesc: 'Складний запит — це кілька простих умов. У кожній частині після коми шлях пишеться повністю.',
    examples: [['#east .tank report', 'донесення про танки на сході'], ['.ad [rel="A"], .ew [rel="A"]', 'надійні дані про ППО і РЕБ']],
    doctrine: {
      title: 'Узагальнення: від даних до рішення',
      body: `<p>Розвідувальний продукт — готова відповідь командиру: що, де, наскільки достовірно, що з цього випливає.</p>
<p>Донесення про противника зручно складати за схемою <b>SALUTE</b>: S — чисельність, A — дії, L — місце, U — належність, T — час, E — озброєння.</p>`
    },
    hint: 'Два варіанти надійності — дві частини через кому, у кожній <code>#east .artillery [rel="…"]</code>.',
    markup: `
<sector id="north">
  <target class="artillery">
    <report class="sigint" rel="A" cred="2"></report>
  </target>
</sector>
<sector id="east">
  <target class="artillery">
    <report class="humint" rel="D" cred="3"></report>
    <report class="imint" rel="A" cred="1"></report>
  </target>
  <target class="tank">
    <report class="imint" rel="A" cred="1"></report>
  </target>
  <target class="artillery">
    <report class="sigint" rel="B" cred="2"></report>
    <report class="osint" rel="E" cred="4"></report>
  </target>
</sector>`
  }
];
