export const MONTH_NAMES = [
    'Enero',
    'Febrero',
    'Marzo',
    'Abril',
    'Mayo',
    'Junio',
    'Julio',
    'Agosto',
    'Septiembre',
    'Octubre',
    'Noviembre',
    'Diciembre'
];

export const JORNADA_OBJETIVO_HORAS = 8;

/** Festivos Chile fijos por mes-dia (misma logica que isHolidayDate). No incluye puentes ni moviles. */
export const CHILE_FIXED_HOLIDAY_MM_DD = new Set([
    '01-01',
    '05-01',
    '05-21',
    '06-29',
    '07-16',
    '08-15',
    '09-18',
    '09-19',
    '10-12',
    '10-31',
    '11-01',
    '12-08',
    '12-25'
]);

export const FACTURABLE_TARGET_PCT_CODE = 85;