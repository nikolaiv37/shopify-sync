/**
 * V3 controlled-name dictionaries and furniture-prefix lists.
 *
 * V3 deliberately does NOT reuse V1 DICTIONARIES wholesale. V1 mixes Bulgarian
 * personal names (Стефани, Моника, Теди, Дани, ...) into bedrooms/kids, which
 * the team flagged as cringe. V3 only uses safe, neutral, place/style names.
 */

export const V3_DICTIONARIES = {
  garden: [
    'Аурора', 'Ривиера', 'Коста', 'Палермо', 'Лагуна', 'Амалфи',
    'Соренто', 'Маре', 'Капри', 'Венеция', 'Неапол', 'Тоскана',
    'Санторини', 'Милано', 'Корсика', 'Балеаро', 'Сицилия', 'Адриатика',
  ],
  chairs: [
    'Верона', 'Милано', 'Комо', 'Сиена', 'Белано', 'Торино',
    'Парма', 'Модена', 'Равена', 'Флоренция', 'Капри', 'Соренто', 'Амалфи',
  ],
  sofas: [
    'Верона', 'Милано', 'Комо', 'Сиена', 'Белано', 'Торино',
    'Парма', 'Модена', 'Равена', 'Флоренция', 'Капри', 'Соренто', 'Амалфи',
  ],
  bedrooms: [
    'Астра', 'Луна', 'Селена', 'Вега', 'Елира',
    'Кристал', 'Диана', 'Бланка', 'Виола', 'Оливия',
  ],
  tables: [
    'Аура', 'Нова', 'Елеганс', 'Модена', 'Лира', 'Сити',
    'Класика', 'Прима', 'Елит', 'Оптимал', 'Палас', 'Роял', 'Империя',
  ],
  wardrobes: [
    'Аура', 'Нова', 'Елеганс', 'Модена', 'Лира', 'Сити',
    'Класика', 'Прима', 'Елит', 'Оптимал', 'Палас', 'Роял', 'Империя',
    'Кристал', 'Астра', 'Вега',
  ],
  kitchens: [
    'Аура', 'Нова', 'Елеганс', 'Модена', 'Лира', 'Сити',
    'Класика', 'Прима', 'Елит', 'Оптимал', 'Палас', 'Роял', 'Империя',
    'Кристал', 'Астра', 'Вега',
  ],
  generic: [
    'Аура', 'Нова', 'Елеганс', 'Модена', 'Лира', 'Сити',
    'Класика', 'Прима', 'Елит', 'Оптимал', 'Палас', 'Роял', 'Империя',
    'Кристал', 'Астра', 'Вега',
  ],
};

/**
 * Furniture prefixes used for "already renamed" detection (Protection A).
 * If a title starts with one of these prefixes followed by a controlled name
 * (any name from any V3 dictionary), the product is treated as already
 * renamed and is never mutated.
 */
export const V3_FURNITURE_PREFIXES = [
  // Garden
  'Градински лаундж сет',
  'Градински трапезен комплект',
  'Градински павилион',
  'Градинска маса',
  'Градинска беседка',
  'Градинска люлка',
  'Градинска пергола',
  'Градински комплект',
  'Сет за външен кът',
  'Комплект градински мебели',
  'Комплект градинска трапезария',
  'Лаундж сет',
  // Sofas / chairs
  'Ъглов диван',
  'Модулен диван',
  'Диван',
  'Тапициран стол',
  'Бар стол',
  'Стол',
  'Кресло',
  'Фотьойл',
  // Bedrooms / storage
  'Спален комплект',
  'Спалня',
  'Двойно легло',
  'Единично легло',
  'Детско легло',
  'Легло',
  'Гардероб за спалня',
  'Гардероб с плъзгащи врати',
  'Ъглов гардероб',
  'Гардероб',
  'Скрин за спалня',
  'Скрин',
  'Тоалетка',
  'Нощно шкафче',
  // Tables / kitchens
  'Трапезна маса',
  'Холна маса',
  'Бар маса',
  'Маса',
  'Кухненски комплект',
  'Кухненски модул',
  'Кухня',
];

/**
 * Flat union of every V3 controlled name. Used by the model-detection step
 * to recognize "the detected old model is actually one of OUR names already"
 * (Protection B), and by replacement to refuse re-allocating an old name.
 */
export const V3_CONTROLLED_NAMES = (() => {
  const set = new Set();
  for (const list of Object.values(V3_DICTIONARIES)) {
    for (const name of list) set.add(name);
  }
  return set;
})();

export function getV3Dictionary(category) {
  return V3_DICTIONARIES[category] || V3_DICTIONARIES.generic;
}

/**
 * Common controlled names that are everyday Bulgarian/foreign words and
 * therefore unsafe to use as a "this title is already renamed" signal on
 * their own. They are still valid replacements (Protection A still uses
 * them — paired with a strong furniture prefix), but Protection B (body-
 * only match) must NEVER fire on these or it would mass-skip ordinary
 * products like "Нова градинска маса", "Кристал стъклена маса", etc.
 */
export const V3_COMMON_NAME_EXCLUSIONS = new Set([
  'Нова', 'Елит', 'Класика', 'Роял', 'Аура',
  'Кристал', 'Астра', 'Вега', 'Сити', 'Прима', 'Оптимал',
]);
