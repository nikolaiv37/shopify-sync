/**
 * Controlled name dictionaries and title-building helpers for product renaming.
 *
 * Strategy: conservative replacement — detect old model/series name,
 * replace only that with a controlled collection name, preserve the rest
 * of the original title, then normalize punctuation and wording.
 *
 * Category workflow: each category has dictionary names, keywords,
 * title prefix rules, and the generator follows a standard structure:
 * "{Category/Product Type} {Name} – {main details}"
 */

const DICTIONARIES = {
  garden: [
    'Аурора', 'Ривиера', 'Коста', 'Палермо', 'Лагуна', 'Амалфи',
    'Соренто', 'Маре', 'Капри', 'Венеция', 'Неапол', 'Тоскана',
    'Санторини', 'Милано', 'Корсика', 'Балеаро', 'Сицилия', 'Адриатика',
  ],
  sofas: [
    'Верона', 'Милано', 'Комо', 'Сиена', 'Белано', 'Тоскана',
    'Ливорно', 'Равена', 'Болоня', 'Парма', 'Фиренце', 'Модена',
    'Бреша', 'Торино', 'Венеция', 'Капри', 'Соренто', 'Амалфи',
  ],
  bedrooms: [
    'Астра', 'Мира', 'Луна', 'Селена', 'Вега', 'Нова', 'Елира',
    'Кристал', 'Аврора', 'Диана', 'Елена', 'Стефани', 'Роза',
    'Бланка', 'Виола', 'Камелия', 'Флора', 'Ирис', 'Моника', 'Оливия',
  ],
  kids: [
    'Сканди', 'Нордик', 'Лили', 'Мони', 'Кая', 'Оли',
    'Бони', 'Дани', 'Еми', 'Софи', 'Теди', 'Юни',
    'Алекс', 'Марти', 'Ники', 'Рали', 'Вики', 'Пепи',
  ],
  tables: [
    'Аура', 'Нова', 'Елеганс', 'Модена', 'Лира', 'Сити',
    'Класика', 'Прима', 'Диадема', 'Елит', 'Оптимал', 'Стандарт',
    'Палас', 'Роял', 'Империя', 'Венеция', 'Милано', 'Торино',
  ],
  wardrobes: [
    'Аура', 'Нова', 'Елеганс', 'Модена', 'Лира', 'Сити',
    'Класика', 'Прима', 'Диадема', 'Елит', 'Оптимал', 'Стандарт',
    'Палас', 'Роял', 'Империя', 'Кристал', 'Астра', 'Вега',
  ],
  kitchens: [
    'Аура', 'Нова', 'Елеганс', 'Модена', 'Лира', 'Сити',
    'Класика', 'Прима', 'Диана', 'Елит', 'Оптимал', 'Стандарт',
    'Палас', 'Роял', 'Империя', 'Кристал', 'Астра', 'Вега',
  ],
  generic: [
    'Аура', 'Нова', 'Елеганс', 'Модена', 'Лира', 'Сити',
    'Класика', 'Прима', 'Диана', 'Елит', 'Оптимал', 'Стандарт',
    'Палас', 'Роял', 'Империя', 'Кристал', 'Астра', 'Вега',
  ],
};

const CATEGORY_KEYWORDS = {
  garden: [
    'градин', 'външен', 'outdoor', 'терас', 'балкон',
    'лаундж сет', 'сет за външен', 'градински', 'плетен', 'ратан',
    'акация', 'pe rattan', 'полиратан', 'pe ратан', 'sheds',
    'daybed', 'полутрап', 'шезлонг', 'люлка', 'бесед', 'пергола',
    'чадър', 'хамaк', 'външна маса', 'външен стол',
    'трапезария', 'трапезна', 'трапезен', 'павилион',
  ],
  sofas: [
    'диван', 'ъглов', 'на диван', 'софа', 'лайфстайл',
    'функция сън', 'разтегател', 'разтегателен', 'ъглова',
    '3-местен', '2-местен', 'модул', 'модулен', 'l-образен',
    'ъглов диван', 'разтег', 'с ракла', 'с кутия',
  ],
  bedrooms: [
    'спалня', 'легло', 'двуместно легло', 'единично легло',
    'табла', 'нощно шкафче', 'скрин', 'тоалетка', 'гардероб',
    'спалня комплект', 'спален комплект', '160x200', '180x200',
    'повдигащ механизъм', 'ракла', 'матрак', 'основа за легло',
  ],
  kids: [
    'детск', 'детска стая', 'детско легло', 'детски',
    'юношеск', 'юношеска', 'бейби', 'бебешк',
    'пион', 'пионер', 'ученическ', 'ученически',
  ],
  tables: [
    'маса', 'трапезна', 'трапезария', 'обедна', 'бар плот',
    'бар маса', 'помощна маса', 'маса за хранене',
    'разтегателна маса', 'разтегателна', 'холна маса', 'журнална',
    'масичка', 'кафе', 'топло', 'стъклена маса', 'дървена маса',
  ],
  wardrobes: [
    'гардероб', 'шкаф', 'дрешник', 'вграден', 'плъзгащи',
    'двукрилен', 'трикрилен', 'четирикрилен', 'еднокрилен',
    'дрешник', 'съблекалня',
  ],
  kitchens: [
    'кухня', 'кухненск', 'кухненски', 'кухненски комплект',
    'кухненски плот', 'горен шкаф', 'долен шкаф', 'кухненски модул',
    'плот за кухня', 'кухненска',
  ],
};

const CATEGORY_TITLE_PREFIXES = {
  garden: {
    lounge: 'Градински лаундж сет',
    dining: 'Градински трапезен комплект',
    pavilion: 'Градински павилион',
    generic: 'Градински комплект',
  },
  sofas: {
    corner: 'Ъглов диван',
    standard: 'Диван',
    modular: 'Модулен диван',
    generic: 'Диван',
  },
  bedrooms: {
    bed: 'Спалня',
    wardrobe: 'Гардероб за спалня',
    dresser: 'Скрин за спалня',
    generic: 'Спалня комплект',
  },
  kids: {
    bed: 'Детско легло',
    desk: 'Детско бюро',
    wardrobe: 'Детски гардероб',
    generic: 'Детска стая',
  },
  tables: {
    dining: 'Трапезна маса',
    coffee: 'Холна маса',
    bar: 'Бар маса',
    generic: 'Маса',
  },
  wardrobes: {
    sliding: 'Гардероб с плъзгащи врати',
    standard: 'Гардероб',
    corner: 'Ъглов гардероб',
    generic: 'Гардероб',
  },
  kitchens: {
    set: 'Кухненски комплект',
    module: 'Кухненски модул',
    generic: 'Кухня',
  },
  generic: {
    generic: 'Комплект',
  },
};

const PRESERVED_WORDS = [
  'градински', 'градинска', 'градинско', 'градин',
  'сет', 'комплект', 'диван', 'ъглов', 'ъглова', 'ъглово',
  'спалня', 'спалнен', 'спалнена', 'легло', 'гардероб',
  'маса', 'стол', 'столове', 'фотьойл', 'фотьойли',
  'акация', 'акациево', 'дърво', 'дъб', 'дъбов', 'метал', 'метален',
  'бежов', 'бежови', 'бежова', 'сив', 'сива', 'сиви', 'сиво',
  'черен', 'черна', 'черно', 'черни', 'бял', 'бяла', 'бяло', 'бели',
  'функция сън', 'ракла', 'повдигащ механизъм', 'повдигащ',
  'разтегателен', 'разтегателна', 'разтегателно', 'разтегател',
  '160x200', '180x200', '140x200', '120x200', '90x200',
  '2-местен', '3-местен', '4 части', '5 части', '6 части',
  'с възглавници', 'възглавници', 'с маса', 'с столове',
  'алуминий', 'алуминиев', 'алуминиева', 'алуминиево',
  'pe ратан', 'полиратан', 'pe rattan', 'текстил', 'текстилен',
  'екру', 'екрю', 'кремав', 'кремаво', 'кафяв', 'кафява',
  'дървен', 'дървена', 'дървено', 'плетен', 'плетена',
  'с ракла', 'с кутия', 'с механизъм', 'с масажен',
];

const BANNED_MODEL_WORDS = new Set([
  'Многофункционален', 'многофункционален', 'Многофункционална', 'многофункционална',
  'Комплект', 'комплект', 'Сет', 'сет', 'Градински', 'градински',
  'Градинска', 'градинска', 'Градинско', 'градинско',
  'Външен', 'външен', 'Външна', 'външна', 'Външно', 'външно',
  'Трапезария', 'трапезария', 'Трапезна', 'трапезна', 'Трапезен', 'трапезен',
  'Хол', 'хол', 'Холна', 'холна', 'Кът', 'кът', 'Части', 'части',
  'Серия', 'серия', 'Серията', 'серията',
  'Дърво', 'дърво', 'Алуминий', 'алуминий', 'Алуминиев', 'алуминиев',
  'Алуминиева', 'алуминиева', 'Ратан', 'ратан', 'Маса', 'маса',
  'Фотьойл', 'фотьойл', 'Фотьойли', 'фотьойли', 'Кресла', 'кресла',
  'Кресло', 'кресло', 'Стол', 'стол', 'Столове', 'столове',
  'Крем', 'крем', 'Кремав', 'кремав', 'Кремава', 'кремава',
  'Сив', 'сив', 'Сива', 'сива', 'Сиви', 'сиви', 'Тъмносив', 'тъмносив',
  'Тъмен', 'тъмен', 'Тъмна', 'тъмна', 'Светъл', 'светъл', 'Светла', 'светла',
  'Бежов', 'бежов', 'Бежова', 'бежова', 'Бежови', 'бежови',
  'Черен', 'черен', 'Черна', 'черна', 'Черни', 'черни',
  'Бял', 'бял', 'Бяла', 'бяла', 'Бели', 'бели',
  'Кафяв', 'кафяв', 'Кафява', 'кафява', 'Кафяви', 'кафяви',
  'Екрю', 'екрю', 'Екруз', 'екруз',
  'Диван', 'диван', 'Ъглов', 'ъглов', 'Ъглова', 'ъглова',
  'Спалня', 'спалня', 'Легло', 'легло', 'Гардероб', 'гардероб',
  'Бар', 'бар', 'Плот', 'плот', 'Помощна', 'помощна',
  'Трапезна', 'трапезна', 'Обедна', 'обедна',
  'Разтегателен', 'разтегателен', 'Разтегателна', 'разтегателна',
  'Функция', 'функция', 'сън', 'Ракла', 'ракла', 'Повдигащ', 'повдигащ',
  'механизъм', 'механизма',
  'PE', 'pe', 'P.E.', 'p.e.', 'Olefin', 'olefin', 'OLEFIN',
  'WICKER', 'wicker', 'SINTERED', 'sintered', 'STONE', 'stone',
  'Teak', 'teak', 'Wicker', 'rattan', 'RATTAN',
  'P.E.', 'P.E', 'плат', 'Плат', 'текстил', 'Текстил',
  'Въже', 'въже', 'Връв', 'връв', 'Ремъци', 'ремъци',
  'Сгъваем', 'сгъваем', 'Сгъваема', 'сгъваема',
  'Режисьорска', 'режисьорска', 'Рециклиран', 'рециклиран',
  'Полипропиленов', 'полипропиленов', 'Полипропиленова', 'полипропиленова',
  'Полипропилен', 'полипропилен', 'Бук', 'бук',
  'Меламинова', 'меламинова', 'Метална', 'метална', 'Метален', 'метален',
  'Стъклена', 'стъклена', 'Стъклен', 'стъклен',
  'Дървена', 'дървена', 'Дървен', 'дървен',
  'Масив', 'масив', 'Орехов', 'орехов', 'Орехова', 'орехова',
  'тапицерия', 'Тапицерия', 'Патина', 'патина', 'Гланц', 'гланц',
  'Антрацит', 'антрацит', 'Фуксия', 'фуксия', 'Капучино', 'капучино',
  'Бебешки', 'бебешки', 'Бебешка', 'бебешка',
  'Детски', 'детски', 'Детска', 'детска', 'Детско', 'детско',
  'от', 'в', 'цвят', 'с', 'см', 'cm', 'бр', 'и', 'на', 'за',
  'Нова', 'нова', 'Стара', 'стара', 'Голям', 'голям', 'Малък', 'малък',
  'Луксозен', 'луксозен', 'Луксозна', 'луксозна', 'Екстра', 'екстра',
  'Премиум', 'премиум', 'Стандарт', 'стандарт', 'Класик', 'класик',
  'Професионална', 'професионална', 'материя', 'Перфорирана', 'перфорирана',
  'TV', 'ТВ', 'шкаф', 'Шкаф', 'Поставка', 'поставка',
  'обувки', 'Офис', 'офис', 'Геймърски', 'геймърски',
  'Павилион', 'павилион', 'Пергола', 'пергола', 'Беседка', 'беседка',
  'Чадър', 'чадър', 'Шезлонг', 'шезлонг', 'Люлка', 'люлка',
  'Хамак', 'хамак', 'Daybed', 'daybed', 'Полутрап', 'полутрап',
  'Резервна', 'резервна', 'част', 'Части', 'части',
  'Двукрилен', 'двукрилен', 'Еднокрилен', 'еднокрилен',
  'Трикрилен', 'трикрилен', 'Четирикрилен', 'четирикрилен',
  'PU', 'pu', 'мрежеста', 'Мрежеста', 'материя', 'Материя',
  'амортисьор', 'Амортисьор', 'хромиран', 'Хромиран',
  'пластмасова', 'Пластмасова', 'основа', 'Основа', 'спици', 'Спици',
  'Висок', 'висок', 'Регулиране', 'регулиране', 'височина', 'Височина',
  'сгъваем', 'Сгъваем', 'помощен', 'Помощен', 'журнална', 'Журнална',
  'кафе', 'Кафе', 'топло', 'Топло', 'плот', 'Плот',
  'серия', 'Серия',
  'многофункционален', 'Многофункционален', 'многофункционална', 'Многофункционална',
  'графински', 'Графински',
  'Директорски', 'директорски',
  'Дамаска', 'дамаска',
  'Слонова', 'слонова', 'Кост', 'кост',
  'Шампанско', 'шампанско', 'Петрол', 'петрол', 'Червен', 'червен',
]);

const MATERIAL_FABRIC_WORDS = new Set([
  'olefin', 'OLEFIN', 'pe', 'PE', 'p.e.',
  'wicker', 'WICKER', 'sintered', 'SINTERED', 'stone', 'STONE',
  'teak', 'rattan', 'RATTAN', 'алуминий', 'дърво',
  'акация', 'акациево', 'дъб', 'дъбов', 'метал', 'метален',
  'полипропилен', 'полипропиленов', 'бук', 'меламин', 'меламинов',
  'стъкло', 'стъклен', 'стъклена', 'текстил', 'текстилен',
  'плетен', 'плетена', 'евкалипт',
  'mdf', 'MDF', 'pvc', 'PVC', 'led', 'LED', 'pu', 'PU',
  'тиково', 'тиков', 'тик',
]);

const KNOWN_MODEL_NAMES = new Set([
  'Baby', 'Altea', 'Queen', 'Clio', 'Orion', 'Corner',
  'Pacific', 'Destiny', 'Eternity', 'Andromeda',
  'Callan', 'Kira', 'Tabia', 'Kalan', 'Desia', 'Rubes',
  'Luna', 'Aria', 'Vega', 'Nova', 'Stella', 'Flora',
  'Athena', 'Hera', 'Zeus', 'Apollo', 'Diana', 'Venus',
  'Milano', 'Roma', 'Torino', 'Verona', 'Capri',
  'Monaco', 'Nice', 'Lyon', 'Paris',
  'Dakota', 'Montana', 'Arizona', 'Nevada',
  'Sofia', 'Rila', 'Pirin', 'Botev', 'Vitosha',
  'Aurora', 'Borealis', 'Cosmos', 'Galaxy', 'Nebula',
  'Titan', 'Atlas', 'Omega', 'Delta', 'Sigma',
  'Riviera', 'Laguna', 'Marina', 'Porto', 'Costa',
  'Amalfi', 'Capri', 'Sorrento', 'Palermo', 'Venice',
  'Chelsea', 'Oxford', 'Cambridge', 'Windsor', 'Dover',
  'Harmony', 'Melody', 'Rhythm', 'Symphony', 'Opera',
  'Crystal', 'Diamond', 'Pearl', 'Ruby', 'Sapphire',
  'Forest', 'Garden', 'Meadow', 'Valley', 'River',
  'Royal', 'Imperial', 'Grand', 'Elite', 'Prime',
  'Classic', 'Modern', 'Urban', 'Metro', 'City',
  'Comfort', 'Relax', 'Dream', 'Sleep', 'Rest',
  'Elegance', 'Grace', 'Charm', 'Style', 'Trend',
  'Enastron', 'Elysia', 'Adhara', 'Ethereal', 'Nexus',
  'Polaris', 'Oasis', 'Pegasus', 'Aura',
]);

const TRUNCATED_PATTERNS = [
  /\s[пП]\s*$/i,
  /\s[оО]\s*$/i,
  /WICKE\b/i,
  /Sintere\b/i,
  /OLEF\b/i,
  /\bкамъ\b/i,
  /SINT\b/i,
  /WICK\b/i,
  /Olefi\b/i,
  /Olefin\s+п\b/i,
  /-си\b\s*$/i,
  /-P\.E\.\s*$/i,
  /\sOL\b(?!\w)/i,
  /\sO\b\s*$/i,
  /плат\s+OLEF\b/i,
  /плат\s+OL\b/i,
  /синтерован\s*$/i,
  /-синтерован\s*$/i,
  /тек-син(?!\w)/i,
  /въже-тек-син(?!\w)/i,
  /-ус\b\s*$/i,
  /крем\/б\b/i,
  /,\s*тъ\b\s*$/i,
  /-тъ\b\s*$/i,
];

function normalizeText(value) {
  if (!value) return '';
  let s = String(value)
    .replace(/\s+/g, ' ')
    .replace(/[–—]/g, '–')
    .trim();

  s = s.replace(/\s*-\s*$/g, '').trim();
  s = s.replace(/\s*,\s*$/g, '').trim();
  s = s.replace(/\s+и\s*$/g, '').trim();
  s = s.replace(/\s+с\s*$/g, '').trim();

  s = s.replace(/,,/g, ',');
  s = s.replace(/,\s*,/g, ',');

  s = s.replace(/тъмно\s+сив/gi, 'тъмносив');
  s = s.replace(/тъмен\s+сив/gi, 'тъмносив');
  s = s.replace(/тъмно\s+кафяв/gi, 'тъмнокафяв');
  s = s.replace(/тъмен\s+кафяв/gi, 'тъмнокафяв');
  s = s.replace(/светло\s+сив/gi, 'светлосив');
  s = s.replace(/светъл\s+сив/gi, 'светлосив');

  s = s.replace(/тъмносиво\s+(алуминий|метал)/gi, 'тъмносив $1');
  s = s.replace(/сиво\s+(алуминий|метал)/gi, 'сив $1');
  s = s.replace(/бежово\s+(алуминий|метал)/gi, 'бежов $1');
  s = s.replace(/тъмносива\s+(маса|стол)/gi, 'тъмносива $1');

  s = s.replace(/\bOLEFIN\b/g, 'Olefin');
  s = s.replace(/\bolefin\b/g, 'Olefin');

  s = s.replace(/дърво\s+акация/gi, 'акациево дърво');
  s = s.replace(/синтерован\s+камъ\b/gi, 'синтерован камък');

  s = normalizeMaterialSeparators(s);

  s = s.replace(/плат\s*-\s*sintered/gi, 'плат и sintered');
  s = s.replace(/olefin\s+плат\s*-\s*sintered/gi, 'Olefin плат и sintered');
  s = s.replace(/алуминий\s*&\s*Olefin/gi, 'алуминий и Olefin плат');
  s = s.replace(/алуминий\s*&\s*olefin/gi, 'алуминий и Olefin плат');

  s = s.replace(/\s*–\s*–/g, '–');
  s = s.replace(/\s*,\s*–/g, '–');
  s = s.replace(/–\s*,/g, '–');

  s = s.replace(/\s{2,}/g, ' ');

  s = s.replace(/\s+-\s+/g, ', ');
  s = s.replace(/,\s*,/g, ',');

  return s.trim();
}

function normalizeMaterialSeparators(s) {
  const replacements = [
    [/алуминий-евкалипт/gi, 'алуминий и евкалипт'],
    [/алуминий-въже/gi, 'алуминий и въже'],
    [/алуминий-връв/gi, 'алуминий и въже'],
    [/алуминий-ратан/gi, 'алуминий и ратан'],
    [/алуминий-усукан\s+ратан/gi, 'алуминий и усукан ратан'],
    [/алуминий-крем\s+плат/gi, 'алуминий и кремав плат'],
    [/алуминий-крем/gi, 'алуминий и кремав'],
    [/алуминий-бежов/gi, 'алуминий и бежов'],
    [/алуминий-беж/gi, 'алуминий и бежов'],
    [/алуминий-сив/gi, 'алуминий и сив'],
    [/алуминий-бял/gi, 'алуминий и бял'],
    [/алуминий-черен/gi, 'алуминий и черен'],
    [/алуминий\s*-\s*olefin/gi, 'алуминий и Olefin'],
    [/алуминий\s*-\s*Olefin/gi, 'алуминий и Olefin'],
    [/алуминий\s*-\s*ратан/gi, 'алуминий и ратан'],
    [/алуминий\s*-\s*текстил/gi, 'алуминий и текстил'],
    [/алуминий\s*-\s*въже/gi, 'алуминий и въже'],
    [/дърво\s*-\s*алуминий/gi, 'дърво и алуминий'],
    [/въже-Olefin/gi, 'въже и Olefin плат'],
    [/въже-olefin/gi, 'въже и Olefin плат'],
    [/плат-Olefin/gi, 'плат и Olefin'],
    [/плат-olefin/gi, 'плат и Olefin'],
    [/плат-sintered/gi, 'плат и sintered'],
    [/olefin\s+плат-sintered/gi, 'Olefin плат и sintered'],
    [/olefin\s+плат-sintered/gi, 'Olefin плат и sintered'],
    [/olefin-стъкло/gi, 'Olefin и стъкло'],
    [/olefin\s+стъкло/gi, 'Olefin и стъкло'],
  ];

  for (const [pattern, replacement] of replacements) {
    s = s.replace(pattern, replacement);
  }

  return s;
}

function repairTruncatedFragments(text, descriptionHtml) {
  if (!text) return text;
  const desc = (descriptionHtml || '').toLowerCase();
  let repaired = text;
  let wasModified = false;

  const repairs = [
    { pattern: /плат\s+OLEF\b/i, fix: 'Olefin плат', descCheck: 'olefin', removeFallback: '' },
    { pattern: /плат\s+OL\b(?!\w)/i, fix: 'Olefin плат', descCheck: 'olefin', removeFallback: '' },
    { pattern: /Olefin\s+п\b/i, fix: 'Olefin плат', descCheck: 'olefin плат', removeFallback: 'Olefin' },
    { pattern: /olefin\s+п\b/i, fix: 'Olefin плат', descCheck: 'olefin плат', removeFallback: 'Olefin' },
    { pattern: /OLEFIN\s+п\b/i, fix: 'Olefin плат', descCheck: 'olefin плат', removeFallback: 'Olefin' },
    { pattern: /Olefi\b/i, fix: 'Olefin плат', descCheck: 'olefin', removeFallback: '' },
    { pattern: /\bOLEF\b/i, fix: 'Olefin плат', descCheck: 'olefin', removeFallback: '' },
    { pattern: /\sOL\b(?!\w)/i, fix: 'Olefin плат', descCheck: 'olefin', removeFallback: '' },

    { pattern: /WICKE\b/i, fix: 'wicker/ратан', descCheck: 'wicker', removeFallback: '' },
    { pattern: /WICK\b/i, fix: 'wicker/ратан', descCheck: 'wicker', removeFallback: '' },
    { pattern: /алуминий-WICKE\b/i, fix: 'алуминий и P.E. wicker/ратан', descCheck: 'wicker', removeFallback: 'алуминий' },
    { pattern: /алуминий-wicker\b/i, fix: 'алуминий и P.E. wicker/ратан', descCheck: 'wicker', removeFallback: 'алуминий' },

    { pattern: /Sintere\b/i, fix: 'sintered stone', descCheck: 'sintered', removeFallback: '' },
    { pattern: /SINT\b/i, fix: 'sintered stone', descCheck: 'sintered', removeFallback: '' },
    { pattern: /синтерован\s+камъ\b/i, fix: 'синтерован камък', descCheck: 'синтерован камък', removeFallback: 'синтерован' },
    { pattern: /синтерован\s+камъ\s*$/i, fix: 'синтерован камък', descCheck: 'синтерован камък', removeFallback: 'синтерован' },
    { pattern: /\bкамъ\b/i, fix: 'камък', descCheck: 'камък', removeFallback: '' },
    { pattern: /-синтерован\s*$/i, fix: '', descCheck: null, removeFallback: '' },
    { pattern: /синтерован\s*$/i, fix: '', descCheck: null, removeFallback: '' },

    { pattern: /въже-P\.?E\.?\s+п\b/i, fix: 'въже и P.E. плат', descCheck: 'p.e. плат', removeFallback: 'въже' },
    { pattern: /въже-P\.?E\.?\b/i, fix: 'въже и P.E.', descCheck: 'p.e.', removeFallback: 'въже' },
    { pattern: /-P\.?E\.?\s+п\b/i, fix: ' и P.E. плат', descCheck: 'p.e. плат', removeFallback: '' },
    { pattern: /-P\.?E\.\s*$/i, fix: ' и P.E. плат', descCheck: 'p.e. плат', removeFallback: '' },

    { pattern: /алуминий-усукан\s+ратан-си\b/i, fix: 'алуминий и усукан ратан', descCheck: 'усукан ратан', removeFallback: 'алуминий и усукан ратан' },
    { pattern: /алуминий-усукан\s+ратан-си\s*$/i, fix: 'алуминий и усукан ратан', descCheck: 'усукан ратан', removeFallback: 'алуминий и усукан ратан' },
    { pattern: /-си\b\s*$/i, fix: '', descCheck: null, removeFallback: '' },
    { pattern: /-си\s*$/i, fix: '', descCheck: null, removeFallback: '' },

    { pattern: /въже-тек-син(?!\w)/i, fix: '', descCheck: 'тик', removeFallback: '' },
    { pattern: /-тек-син(?!\w)/i, fix: '', descCheck: null, removeFallback: '' },
    { pattern: /тек-син(?!\w)/i, fix: '', descCheck: null, removeFallback: '' },

    { pattern: /\s[пП]\s*$/i, fix: ' плат', descCheck: 'плат', removeFallback: '' },
    { pattern: /\s[оО]\s*$/i, fix: '', descCheck: null, removeFallback: '' },
    { pattern: /\sO\b\s*$/i, fix: '', descCheck: null, removeFallback: '' },

    { pattern: /-ус\b\s*$/i, fix: '', descCheck: null, removeFallback: '' },
    { pattern: /крем\/б\b/i, fix: 'крем', descCheck: 'крем', removeFallback: 'крем' },
    { pattern: /,\s*тъ\b\s*$/i, fix: '', descCheck: null, removeFallback: '' },
    { pattern: /-тъ\b\s*$/i, fix: '', descCheck: null, removeFallback: '' },
  ];

  for (const r of repairs) {
    if (r.pattern.test(repaired)) {
      if (r.descCheck && desc.includes(r.descCheck)) {
        repaired = repaired.replace(r.pattern, r.fix);
        wasModified = true;
      } else if (r.removeFallback !== undefined) {
        repaired = repaired.replace(r.pattern, r.removeFallback);
        wasModified = true;
      }
    }
  }

  repaired = repaired.replace(/\s*[-–]\s*$/g, '').trim();
  repaired = repaired.replace(/^\s*[-–]\s*/g, '').trim();
  repaired = repaired.replace(/\s*,\s*$/g, '').trim();
  repaired = repaired.replace(/\s*\.\s*$/g, '').trim();
  repaired = repaired.replace(/\.\./g, '.');
  repaired = repaired.replace(/,\s*,/g, ',');
  repaired = repaired.replace(/\s{2,}/g, ' ');

  repaired = repaired.replace(/плат\s+Olefin\s+плат/gi, 'Olefin плат');
  repaired = repaired.replace(/плат\s+и\s+Olefin\s+плат/gi, 'Olefin плат');
  repaired = repaired.replace(/(\w+)\s+и\s+(\w+)\s+и\s+Olefin\s+плат/gi, '$1, $2 и Olefin плат');
  repaired = repaired.replace(/алуминий\s+Olefin/gi, 'алуминий и Olefin');
  repaired = repaired.replace(/плат\s+плат/gi, 'плат');
  repaired = repaired.replace(/алуминий\s+алуминий/gi, 'алуминий');
  repaired = repaired.replace(/ратан\/ратан/gi, 'ратан');
  repaired = repaired.replace(/wicker\/ратан\/ратан/gi, 'wicker/ратан');
  repaired = repaired.replace(/платOlefin/g, 'плат и Olefin');
  repaired = repaired.replace(/плат-Olefin/gi, 'плат и Olefin');
  repaired = repaired.replace(/въже-Olefin/gi, 'въже и Olefin плат');
  repaired = repaired.replace(/P\.E\.\./g, 'P.E.');
  repaired = repaired.replace(/P\.E\b(?!\.)/g, 'P.E.');
  repaired = repaired.replace(/\s\.\s*$/g, '').trim();
  repaired = repaired.replace(/въже\.\s*$/g, 'въже');

  return { text: repaired, wasModified };
}

function cleanBrokenFragments(text) {
  if (!text) return text;
  let s = text;

  const brokenPatterns = [
    /\s[пП]\s*$/i,
    /\s[оО]\s*$/i,
    /\sO\b\s*$/i,
    /\sOL\b(?!\w)/i,
    /WICKE\b/i,
    /WICK\b/i,
    /Sintere\b/i,
    /SINT\b/i,
    /OLEF\b/i,
    /Olefi\b/i,
    /Olefin\s+п\b/i,
    /-си\b\s*$/i,
    /-си\s*$/i,
    /-P\.E\.\s*$/i,
    /\bкамъ\b/i,
    /-синтерован\s*$/i,
    /синтерован\s*$/i,
    /въже-тек-син(?!\w)/i,
    /-тек-син(?!\w)/i,
    /тек-син(?!\w)/i,
    /плат\s+OLEF\b/i,
    /плат\s+OL\b(?!\w)/i,
    /-ус\b\s*$/i,
    /крем\/б\b/i,
    /,\s*тъ\b\s*$/i,
    /-тъ\b\s*$/i,
  ];

  for (const pattern of brokenPatterns) {
    s = s.replace(pattern, '');
  }

  s = s.replace(/\s*[-–]\s*$/g, '').trim();
  s = s.replace(/^\s*[-–]\s*/g, '').trim();
  s = s.replace(/\s*,\s*$/g, '').trim();
  s = s.replace(/,\s*,/g, ',');
  s = s.replace(/\s{2,}/g, ' ');

  return s.trim();
}

function detectCategoryFromProduct(product) {
  const title = (product.title || '').toLowerCase();
  const productType = (product.productType || '').toLowerCase();
  const tags = (product.tags || []).join(' ').toLowerCase();
  const description = (product.descriptionHtml || '').toLowerCase();
  const combined = `${title} ${productType} ${tags} ${description}`;

  const scores = {};
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (combined.includes(kw)) score++;
    }
    scores[category] = score;
  }

  let bestCategory = 'generic';
  let bestScore = 0;
  for (const [category, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestCategory;
}

function detectProductTypeFromTitle(title) {
  if (!title) return 'generic';
  const lower = title.toLowerCase();

  if (lower.includes('павилион')) return 'pavilion';
  if (lower.includes('трапезария') || lower.includes('трапезен') || lower.includes('трапезна')
      || lower.includes('маса и 6') || lower.includes('маса и 8')
      || lower.includes('маса и 4') || lower.includes('маса и 2')
      || lower.includes('фотьойла') || lower.includes('кресла')
      || lower.includes('столове')) return 'dining';
  if (lower.includes('ъглов') || lower.includes('външен кът') || lower.includes('хол')
      || lower.includes('салон') || lower.includes('диван')
      || lower.includes('лаундж') || lower.includes('daybed')
      || lower.includes('полутрап') || lower.includes('шезлонг')) return 'lounge';

  return 'generic';
}

function detectModelNameFromTitle(title) {
  if (!title) return null;
  const cleaned = normalizeText(title);
  const words = cleaned.split(/\s+/);

  const isLatinWord = (w) => /^[A-Za-z0-9\-]+$/.test(w);
  const hasCyrillic = (w) => /[А-Яа-яЁё]/.test(w);
  const isCyrillicProper = (w) => /^[А-ЯЁ][а-яё]{2,}$/.test(w);
  const isBanned = (w) => BANNED_MODEL_WORDS.has(w) || BANNED_MODEL_WORDS.has(w.toLowerCase());
  const isMaterial = (w) => MATERIAL_FABRIC_WORDS.has(w.toLowerCase());
  const isKnownModel = (w) => KNOWN_MODEL_NAMES.has(w);
  const isPureDigits = (w) => /^\d+$/.test(w) || /^\d+x\d+$/.test(w);

  const candidates = [];

  for (let i = 0; i < words.length; i++) {
    const cleanWord = words[i].replace(/[,.:;()]/g, '');
    if (!cleanWord || cleanWord.length < 2 || cleanWord.length > 30) continue;
    if (isBanned(cleanWord)) continue;
    if (isMaterial(cleanWord)) continue;
    if (isPureDigits(cleanWord)) continue;

    const pureLatin = isLatinWord(cleanWord);
    const hasCyr = hasCyrillic(cleanWord);
    const isCyrProper = isCyrillicProper(cleanWord);

    if (pureLatin && !hasCyr) {
      const priority = isKnownModel(cleanWord) ? 20 : 10;
      candidates.push({ word: cleanWord, priority, index: i, isLatin: true });
    } else if (isCyrProper) {
      candidates.push({ word: cleanWord, priority: 2, index: i, isLatin: false });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.index - b.index;
  });

  const best = candidates[0];

  if (best.isLatin && best.priority >= 10) {
    const sequence = buildLatinModelSequence(words, best.index, isLatinWord, hasCyrillic, isBanned, isMaterial, isPureDigits, isKnownModel);
    if (sequence) return sequence;
    return best.word;
  }

  if (best.priority === 2) {
    const next = candidates[1];
    if (next && next.isLatin && next.priority >= 10) {
      const sequence = buildLatinModelSequence(words, next.index, isLatinWord, hasCyrillic, isBanned, isMaterial, isPureDigits, isKnownModel);
      if (sequence) return sequence;
      return next.word;
    }
  }

  return best.word;
}

function buildLatinModelSequence(words, startIndex, isLatinWord, hasCyrillic, isBanned, isMaterial, isPureDigits, isKnownModel) {
  const sequence = [];
  for (let i = startIndex; i < words.length && sequence.length < 3; i++) {
    const w = words[i].replace(/[,.:;()]/g, '');
    if (!w || w.length < 2) break;
    if (isPureDigits(w)) break;
    if (hasCyrillic(w)) break;
    if (isBanned(w) && !isKnownModel(w)) break;
    if (isMaterial(w)) break;
    if (isLatinWord(w)) {
      sequence.push(w);
    } else {
      break;
    }
  }
  return sequence.length > 0 ? sequence.join(' ') : null;
}

function extractPieces(title) {
  if (!title) return null;
  const match = title.match(/(\d+)\s*части/i);
  if (match) return `${match[1]} части`;

  const match2 = title.match(/с\s+(маса\s+и\s+\d+\s+(?:фотьойла|кресла|стола))/i);
  if (match2) return match2[1];

  const match3 = title.match(/с\s+(\d+\s+(?:кресла|стола|фотьойла))/i);
  if (match3) return match3[1];

  return null;
}

function getTypePrefix(category, productType) {
  const catPrefixes = CATEGORY_TITLE_PREFIXES[category] || CATEGORY_TITLE_PREFIXES.generic;
  return catPrefixes[productType] || catPrefixes.generic || 'Комплект';
}

function buildRenamedTitle(product, detectedCategory, newName) {
  const title = normalizeText(product.title || '');
  if (!title) return null;

  const productType = detectProductTypeFromTitle(title);
  const oldModel = detectModelNameFromTitle(title);
  const pieces = extractPieces(title);

  if (!oldModel) {
    return buildTitleWithoutModel(title, detectedCategory, newName, productType, pieces);
  }

  const escaped = oldModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let body = title.replace(new RegExp(escaped, 'gi'), '').trim();

  body = body.replace(/^сет\s+за\s+външен\s+кът\s*/gi, '').trim();
  body = body.replace(/^градински\s+комплект\s*/gi, '').trim();
  body = body.replace(/^комплект\s+за\s+хранене\s*/gi, '').trim();
  body = body.replace(/^трапезна\s+маса\s*/gi, '').trim();
  body = body.replace(/^трапезария\s*/gi, '').trim();
  body = body.replace(/^сет\s+трапезария\s+за\s+външно\s+пространство\s*/gi, '').trim();
  body = body.replace(/^серия\s*/gi, '').trim();
  body = body.replace(/^ъглов\s+комплект\s+за\s+хол\s*/gi, '').trim();
  body = body.replace(/^сет\s+за\s+външен\s+ъгъл\s*/gi, '').trim();
  body = body.replace(/^многофункционален\s+комплект\s+за\s+външен\s+кът\s*/gi, '').trim();
  body = body.replace(/^комплект\s+градински\s+мебели\s*/gi, '').trim();

  body = body.replace(/серия\s*/gi, '').trim();
  body = body.replace(/Corner\s*/gi, '').trim();
  body = body.replace(/Комплект\s+градински\s+мебели\s*/gi, '').trim();

  body = body.replace(/^[-–,]\s*/, '').trim();
  body = body.replace(/[-–,]\s*$/, '').trim();

  if (!body) return null;

  const typePrefix = getTypePrefix(detectedCategory, productType);

  let newTitle = `${typePrefix} ${newName}`;

  if (pieces && !body.toLowerCase().includes(pieces.toLowerCase())) {
    newTitle += ` – ${pieces}`;
  }

  if (body) {
    if (newTitle.includes('–')) {
      newTitle += `, ${body}`;
    } else {
      newTitle += ` – ${body}`;
    }
  }

  newTitle = normalizeText(newTitle);

  if (pieces && newTitle.includes('–')) {
    const dashIdx = newTitle.indexOf('–');
    const afterDash = newTitle.slice(dashIdx + 1).trim();
    const piecesRegex = new RegExp(`(${pieces.replace(/\s/g, '\\s*')})\\s*`, 'i');
    if (piecesRegex.test(afterDash)) {
      let modified = afterDash.replace(piecesRegex, '$1, ');
      modified = modified.replace(/,\s*,/g, ',').replace(/,\s*$/g, '').trim();
      newTitle = newTitle.slice(0, dashIdx + 1).trim() + ' ' + modified;
    } else if (afterDash && !afterDash.startsWith(pieces + ',')) {
      newTitle = newTitle.slice(0, dashIdx + 1).trim() + ` ${pieces}, ${afterDash}`;
    }
  }

  newTitle = deduplicateWords(newTitle);
  newTitle = normalizeText(newTitle);

  return newTitle;
}

function buildTitleWithoutModel(title, detectedCategory, newName, productType, pieces) {
  let cleaned = normalizeText(title);

  cleaned = cleaned.replace(/^сет\s+за\s+външен\s+кът\s*/gi, '').trim();
  cleaned = cleaned.replace(/^градински\s+комплект\s*/gi, '').trim();
  cleaned = cleaned.replace(/^комплект\s+за\s+хранене\s*/gi, '').trim();
  cleaned = cleaned.replace(/^трапезна\s+маса\s*/gi, '').trim();
  cleaned = cleaned.replace(/^трапезария\s*/gi, '').trim();
  cleaned = cleaned.replace(/^сет\s+трапезария\s+за\s+външно\s+пространство\s*/gi, '').trim();
  cleaned = cleaned.replace(/^серия\s*/gi, '').trim();
  cleaned = cleaned.replace(/^ъглов\s+комплект\s+за\s+хол\s*/gi, '').trim();
  cleaned = cleaned.replace(/^многофункционален\s+комплект\s+за\s+външен\s+кът\s*/gi, '').trim();
  cleaned = cleaned.replace(/^комплект\s+градински\s+мебели\s*/gi, '').trim();

  cleaned = cleaned.replace(/^[-–,]\s*/, '').trim();
  cleaned = cleaned.replace(/[-–,]\s*$/, '').trim();

  if (!cleaned) return null;

  const typePrefix = getTypePrefix(detectedCategory, productType);

  let newTitle = `${typePrefix} ${newName} – ${cleaned}`;
  newTitle = normalizeText(newTitle);

  if (pieces && !newTitle.toLowerCase().includes(pieces.toLowerCase())) {
    const dashIdx = newTitle.indexOf('–');
    if (dashIdx >= 0) {
      newTitle = newTitle.slice(0, dashIdx + 1).trim() + ` ${pieces},` + newTitle.slice(dashIdx + 1);
    } else {
      newTitle += `, ${pieces}`;
    }
    newTitle = normalizeText(newTitle);
  }

  if (pieces && newTitle.includes('–')) {
    const dashIdx = newTitle.indexOf('–');
    const afterDash = newTitle.slice(dashIdx + 1).trim();
    const piecesRegex = new RegExp(`(${pieces.replace(/\s/g, '\\s*')})\\s*`, 'i');
    if (piecesRegex.test(afterDash)) {
      let modified = afterDash.replace(piecesRegex, '$1, ');
      modified = modified.replace(/,\s*,/g, ',').replace(/,\s*$/g, '').trim();
      newTitle = newTitle.slice(0, dashIdx + 1).trim() + ' ' + modified;
    }
  }

  newTitle = deduplicateWords(newTitle);
  newTitle = normalizeText(newTitle);

  return newTitle;
}

function deduplicateWords(title) {
  if (!title) return '';

  let result = title;

  result = result.replace(/плат\s+Olefin\s+плат/gi, 'Olefin плат');
  result = result.replace(/плат\s+и\s+Olefin\s+плат/gi, 'Olefin плат');
  result = result.replace(/(\S+)\s+и\s+(\S+)\s+и\s+Olefin\s+плат/gi, '$1, $2 и Olefin плат');
  result = result.replace(/(\S+)\s+и\s+въже\s+и\s+Olefin/gi, '$1, въже и Olefin');
  result = result.replace(/(\S+)\s+и\s+(\S+)\s+и\s+(\S+)/gi, (match, a, b, c) => {
    if (b === 'и') return match;
    return `${a}, ${b} и ${c}`;
  });
  result = result.replace(/алуминий\s+Olefin/gi, 'алуминий и Olefin');
  result = result.replace(/платOlefin/g, 'плат и Olefin');
  result = result.replace(/плат-Olefin/gi, 'плат и Olefin');
  result = result.replace(/въже-Olefin/gi, 'въже и Olefin плат');
  result = result.replace(/плат\s+плат/gi, 'плат');
  result = result.replace(/алуминий\s+алуминий/gi, 'алуминий');
  result = result.replace(/ратан\/ратан/gi, 'ратан');
  result = result.replace(/wicker\/ратан\/ратан/gi, 'wicker/ратан');
  result = result.replace(/P\.E\.\./g, 'P.E.');
  result = result.replace(/P\.E\b/g, 'P.E.');
  result = result.replace(/\s\.\s*$/g, '').trim();
  result = result.replace(/\s*[-–]\s*$/g, '').trim();

  result = result.replace(/и\s+Olefin\s+плат\s+и\s+/gi, 'Olefin плат, ');

  const parts = result.split('–').map((p) => p.trim());
  if (parts.length > 1) {
    const prefix = parts[0];
    const rest = parts.slice(1).join('–');

    const prefixWords = new Set(prefix.toLowerCase().split(/\s+/));
    const restWords = rest.split(/,\s*/);
    const uniqueRest = restWords.filter((segment) => {
      const segWords = segment.toLowerCase().split(/\s+/);
      return !segWords.every((w) => prefixWords.has(w));
    });

    result = normalizeText(`${prefix} – ${uniqueRest.join(', ')}`);

    result = result.replace(/плат\s+плат/gi, 'плат');
    result = result.replace(/алуминий\s+алуминий/gi, 'алуминий');

    return result;
  }

  result = result.replace(/плат\s+плат/gi, 'плат');
  result = result.replace(/алуминий\s+алуминий/gi, 'алуминий');
  return result;
}

function getDictionaryForCategory(category) {
  return DICTIONARIES[category] || DICTIONARIES.generic;
}

function pickNewName(category, index) {
  const dict = getDictionaryForCategory(category);
  return dict[index % dict.length];
}

export {
  DICTIONARIES,
  CATEGORY_KEYWORDS,
  CATEGORY_TITLE_PREFIXES,
  PRESERVED_WORDS,
  BANNED_MODEL_WORDS,
  MATERIAL_FABRIC_WORDS,
  KNOWN_MODEL_NAMES,
  TRUNCATED_PATTERNS,
  normalizeText,
  normalizeMaterialSeparators,
  repairTruncatedFragments,
  cleanBrokenFragments,
  detectCategoryFromProduct,
  detectProductTypeFromTitle,
  detectModelNameFromTitle,
  extractPieces,
  getTypePrefix,
  buildRenamedTitle,
  buildTitleWithoutModel,
  deduplicateWords,
  getDictionaryForCategory,
  pickNewName,
};
