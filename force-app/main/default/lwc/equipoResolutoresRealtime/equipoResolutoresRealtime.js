import { subscribe, unsubscribe, onError } from 'lightning/empApi';

/** Canal Platform Event para refresco multi-usuario. */
export const EQUIPO_SLA_EVENT_CHANNEL = '/event/Pandora_Equipo_Sla_Change__e';

const DEBOUNCE_MS = 400;
const debounceTimers = new Map();
let empErrorRegistered = false;

/**
 * Suscripción empApi con filtro por usuario y debounce por Case.
 * @param {Object} options
 * @param {string} options.userId - Id del usuario actual (005...)
 * @param {function} options.onNotify - ({ caseId, changeType, correlationId }) => void
 * @param {function} [options.shouldHandle] - ({ caseId, changeType }) => boolean
 * @returns {{ disconnect: function }}
 */
export function createEquipoRealtimeSubscription({ userId, onNotify, shouldHandle }) {
    const subscription = { channel: null };

    const messageCallback = (message) => {
        const payload = message?.data?.payload;
        if (!payload) {
            return;
        }

        const caseId = payload.Case_Id__c;
        const changeType = payload.Change_Type__c;
        const correlationId = payload.Correlation_Id__c;
        const notifyRaw = payload.Notify_User_Ids__c || '';
        const notifyIds = notifyRaw.split(';').filter(Boolean);

        if (userId && notifyIds.length > 0 && !notifyIds.includes(userId)) {
            return;
        }

        const detail = { caseId, changeType, correlationId };
        if (typeof shouldHandle === 'function' && !shouldHandle(detail)) {
            return;
        }

        const debounceKey = caseId || '_any_';
        scheduleDebounce(debounceKey, () => {
            if (typeof onNotify === 'function') {
                onNotify(detail);
            }
        });
    };

    subscribe(EQUIPO_SLA_EVENT_CHANNEL, -1, messageCallback).then((response) => {
        subscription.channel = response;
    });

    registerEmpErrorOnce();

    return {
        disconnect() {
            if (subscription.channel) {
                unsubscribe(subscription.channel, () => {});
                subscription.channel = null;
            }
        }
    };
}

function scheduleDebounce(key, fn) {
    const existing = debounceTimers.get(key);
    if (existing) {
        clearTimeout(existing);
    }
    const timerId = setTimeout(() => {
        debounceTimers.delete(key);
        fn();
    }, DEBOUNCE_MS);
    debounceTimers.set(key, timerId);
}

function registerEmpErrorOnce() {
    if (empErrorRegistered) {
        return;
    }
    onError(() => {
        // Si empApi falla, el sondeo de respaldo sigue activo.
    });
    empErrorRegistered = true;
}
