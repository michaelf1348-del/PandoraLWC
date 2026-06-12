public with sharing class BacklogKaufmannController {
    private static final String GESTIONES_API = 'Gestiones_Kaufmann__c';

    /* Jornada laboral diaria usada en la fórmula del BACKLOG IDEAL: % ASIGNACION = (DIAS EJECUTADOS * 100) / 8. */
    private static final Decimal HORAS_LABORALES = 8;

    /* La lógica de negocio (filtro de exclusión + excepciones) se basa en Tipo_de_Tarea__c,
       que es el campo que contiene Desarrollo / Ajustes / Planificación. Tarea__c contiene el
       código de tarea de ServiceNow (DMNTSK...) y no se usa para la lógica. */
    private static final Set<String> EXCLUDED_TIPO_TAREA = new Set<String>{
        'Pruebas de Usuario',
        'Pruebas Consultor',
        'Preparación Paso a Producción',
        'Paso a Producción',
        'Validación Paso a Producción'
    };

    private static final String TIPO_DESARROLLO = 'Desarrollo';
    private static final String TIPO_AJUSTES = 'Ajustes';
    private static final String ESTADO_PENDIENTE = 'Pendiente';
    private static final String ESTADO_EN_CURSO = 'En curso';

    public class BacklogSummary {
        @AuraEnabled public Integer totalRecords;
        @AuraEnabled public Integer enCurso;
        @AuraEnabled public Integer pendiente;
        @AuraEnabled public Decimal totalHoras;
    }

    public class BacklogRow {
        @AuraEnabled public Id id;
        @AuraEnabled public String idRef;
        @AuraEnabled public String demanda;
        @AuraEnabled public String proyecto;
        @AuraEnabled public String descripcion;
        @AuraEnabled public String consultorKaufmann;
        @AuraEnabled public String tipoTarea;
        @AuraEnabled public String estado;
        @AuraEnabled public String consultorSeidor;
        @AuraEnabled public Decimal hhTotal;
        @AuraEnabled public Date fechaInicio;
        @AuraEnabled public Date fechaPlanQa;
        @AuraEnabled public Decimal asignacionTarea;
        @AuraEnabled public Decimal avanceReal;
        @AuraEnabled public String recordUrl;
    }

    public class BacklogDataResult {
        @AuraEnabled public List<BacklogRow> rows;
        @AuraEnabled public BacklogSummary summary;
        @AuraEnabled public List<String> tipoTareaOptions;
        @AuraEnabled public List<String> estadoOptions;
    }

    @AuraEnabled(cacheable=true)
    public static BacklogDataResult getBacklogData(String searchTerm, String tipoTareaFilter, String estadoFilter) {
        try {
            assertReadable();

            String term = String.isBlank(searchTerm) ? null : '%' + String.escapeSingleQuotes(searchTerm.trim()) + '%';
            String tipoTarea = String.isBlank(tipoTareaFilter) ? null : tipoTareaFilter.trim();
            String estado = String.isBlank(estadoFilter) ? null : estadoFilter.trim();

            Set<String> excludedTipos = EXCLUDED_TIPO_TAREA;

            List<String> conditions = new List<String>();
            conditions.add('(Tipo_de_Tarea__c = null OR Tipo_de_Tarea__c NOT IN :excludedTipos)');

            if (term != null) {
                conditions.add(
                    '(Name LIKE :term OR Demanda__c LIKE :term OR Proyecto_Principal__c LIKE :term ' +
                    'OR Descripci_n_breve__c LIKE :term OR Consultor_Seidor__c LIKE :term ' +
                    'OR Consultor_Kaufmann_t__c LIKE :term)'
                );
            }
            if (tipoTarea != null) {
                conditions.add('Tipo_de_Tarea__c = :tipoTarea');
            }
            if (estado != null) {
                conditions.add('Estado__c = :estado');
            }

            String soql =
                'SELECT Id, Name, Demanda__c, Proyecto_Principal__c, Descripci_n_breve__c, ' +
                'Consultor_Kaufmann__c, Consultor_Kaufmann__r.Name, Consultor_Kaufmann_t__c, ' +
                'Tipo_de_Tarea__c, Estado__c, Consultor_Seidor__c, HH_Total__c, Fecha_de_Inicio__c, ' +
                'Fecha_Plan_QA__c, Asignaci_n_a_la_tarea__c, Avance_Real__c ' +
                'FROM Gestiones_Kaufmann__c WHERE ' +
                String.join(conditions, ' AND ') +
                ' ORDER BY Proyecto_Principal__c ASC NULLS LAST, Demanda__c ASC NULLS LAST ' +
                'LIMIT 2000';

            List<SObject> records = Database.query(soql);

            BacklogDataResult result = new BacklogDataResult();
            result.rows = new List<BacklogRow>();
            result.summary = new BacklogSummary();
            result.summary.totalRecords = 0;
            result.summary.enCurso = 0;
            result.summary.pendiente = 0;
            result.summary.totalHoras = 0;

            Set<String> tipos = new Set<String>();
            Set<String> estados = new Set<String>();

            for (SObject raw : records) {
                BacklogRow row = mapRow(raw);
                result.rows.add(row);
                result.summary.totalRecords++;

                if (row.hhTotal != null) {
                    result.summary.totalHoras += row.hhTotal;
                }
                if (isMatch(row.estado, ESTADO_EN_CURSO)) {
                    result.summary.enCurso++;
                } else if (isMatch(row.estado, ESTADO_PENDIENTE)) {
                    result.summary.pendiente++;
                }

                if (!String.isBlank(row.tipoTarea)) {
                    tipos.add(row.tipoTarea);
                }
                if (!String.isBlank(row.estado)) {
                    estados.add(row.estado);
                }
            }

            result.tipoTareaOptions = sortedList(tipos);
            result.estadoOptions = sortedList(estados);
            return result;
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            throw new AuraHandledException('Error al cargar el backlog: ' + e.getMessage());
        }
    }

    /**
     * Recalcula y persiste % ASIGNACION A LA TAREA y % AVANCE REAL para todas las gestiones del
     * backlog (excluyendo tareas de pruebas/PRD), replicando las fórmulas del BACKLOG IDEAL:
     *   DIAS TOTALES   = NETWORKDAYS(Fecha_de_Inicio__c, Fecha_Plan_QA__c)
     *   DIAS EJECUTADOS= NETWORKDAYS(Fecha_de_Inicio__c, HOY)
     *   HH por DIA     = HH_Total__c / DIAS TOTALES
     *   HH ejecutadas  = DIAS EJECUTADOS * HH por DIA
     *   % AVANCE REAL  = (HH ejecutadas * 100) / HH_Total__c
     *   % ASIGNACION   = (DIAS EJECUTADOS * 100) / 8
     * Excepciones (no se tocan las fechas origen):
     *   Ajustes   + Pendiente -> asignacion 0, avance 90
     *   Desarrollo+ Pendiente -> asignacion 0, avance 0
     *   Ajustes   + En curso  -> asignacion 0, avance 93
     */
    @AuraEnabled
    public static Integer recalcularIndicadores() {
        try {
            Schema.SObjectType sot = Gestiones_Kaufmann__c.SObjectType;
            if (!sot.getDescribe().isUpdateable()) {
                throw new AuraHandledException('No tienes permiso para modificar gestiones Kaufmann.');
            }

            Set<String> excludedTipos = EXCLUDED_TIPO_TAREA;
            List<Gestiones_Kaufmann__c> records = [
                SELECT Id, Tipo_de_Tarea__c, Estado__c, HH_Total__c,
                       Fecha_de_Inicio__c, Fecha_Plan_QA__c,
                       Asignaci_n_a_la_tarea__c, Avance_Real__c
                FROM Gestiones_Kaufmann__c
                WHERE Tipo_de_Tarea__c = null OR Tipo_de_Tarea__c NOT IN :excludedTipos
                LIMIT 10000
            ];

            Date hoy = Date.today();
            List<Gestiones_Kaufmann__c> toUpdate = new List<Gestiones_Kaufmann__c>();

            for (Gestiones_Kaufmann__c rec : records) {
                Decimal asignacion;
                Decimal avance;

                if (isMatch(rec.Tipo_de_Tarea__c, TIPO_AJUSTES) && isMatch(rec.Estado__c, ESTADO_PENDIENTE)) {
                    asignacion = 0;
                    avance = 90;
                } else if (isMatch(rec.Tipo_de_Tarea__c, TIPO_DESARROLLO) && isMatch(rec.Estado__c, ESTADO_PENDIENTE)) {
                    asignacion = 0;
                    avance = 0;
                } else if (isMatch(rec.Tipo_de_Tarea__c, TIPO_AJUSTES) && isMatch(rec.Estado__c, ESTADO_EN_CURSO)) {
                    asignacion = 0;
                    avance = 93;
                } else {
                    Integer diasTotales = networkDays(rec.Fecha_de_Inicio__c, rec.Fecha_Plan_QA__c);
                    Integer diasEjecutados = networkDays(rec.Fecha_de_Inicio__c, hoy);
                    Decimal hhTotal = rec.HH_Total__c;

                    Decimal hhPorDia = (diasTotales > 0 && hhTotal != null)
                        ? hhTotal / diasTotales
                        : 0;
                    Decimal hhEjecutadas = diasEjecutados * hhPorDia;

                    avance = (hhTotal != null && hhTotal != 0)
                        ? (hhEjecutadas * 100) / hhTotal
                        : 0;
                    asignacion = (diasEjecutados * 100) / HORAS_LABORALES;
                }

                asignacion = asignacion.setScale(2, System.RoundingMode.HALF_UP);
                avance = avance.setScale(2, System.RoundingMode.HALF_UP);

                if (rec.Asignaci_n_a_la_tarea__c != asignacion || rec.Avance_Real__c != avance) {
                    rec.Asignaci_n_a_la_tarea__c = asignacion;
                    rec.Avance_Real__c = avance;
                    toUpdate.add(rec);
                }
            }

            if (!toUpdate.isEmpty()) {
                SObjectAccessDecision decision = Security.stripInaccessible(AccessType.UPDATABLE, toUpdate);
                update decision.getRecords();
            }
            return toUpdate.size();
        } catch (AuraHandledException e) {
            throw e;
        } catch (DmlException e) {
            throw new AuraHandledException('Error al recalcular: ' + e.getDmlMessage(0));
        } catch (Exception e) {
            throw new AuraHandledException('Error al recalcular: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static void updateBacklogRecords(List<Gestiones_Kaufmann__c> records) {
        try {
            if (records == null || records.isEmpty()) {
                return;
            }

            Schema.SObjectType sot = Gestiones_Kaufmann__c.SObjectType;
            if (!sot.getDescribe().isUpdateable()) {
                throw new AuraHandledException('No tienes permiso para modificar gestiones Kaufmann.');
            }

            SObjectAccessDecision decision = Security.stripInaccessible(AccessType.UPDATABLE, records);
            update decision.getRecords();
        } catch (AuraHandledException e) {
            throw e;
        } catch (DmlException e) {
            throw new AuraHandledException('Error al guardar cambios: ' + e.getDmlMessage(0));
        } catch (Exception e) {
            throw new AuraHandledException('Error al guardar cambios: ' + e.getMessage());
        }
    }

    /**
     * Equivalente a la función NETWORKDAYS de Excel (sin lista de festivos):
     * cuenta los días hábiles (lunes a viernes) entre startD y endD, ambos inclusive.
     */
    @TestVisible
    private static Integer networkDays(Date startD, Date endD) {
        if (startD == null || endD == null || startD > endD) {
            return 0;
        }
        Integer inclusiveDays = startD.daysBetween(endD) + 1;
        Integer fullWeeks = inclusiveDays / 7;
        Integer business = fullWeeks * 5;
        Integer remainder = Math.mod(inclusiveDays, 7);
        Integer startDow = mondayIndex(startD);
        for (Integer i = 0; i < remainder; i++) {
            if (Math.mod(startDow + i, 7) <= 4) {
                business++;
            }
        }
        return business;
    }

    /** 0 = lunes ... 6 = domingo. */
    private static Integer mondayIndex(Date d) {
        Date refMonday = Date.newInstance(2020, 1, 6);
        Integer diff = refMonday.daysBetween(d);
        return Math.mod(Math.mod(diff, 7) + 7, 7);
    }

    private static void assertReadable() {
        Schema.SObjectType sot = Gestiones_Kaufmann__c.SObjectType;
        if (!sot.getDescribe().isAccessible()) {
            throw new AuraHandledException('No tienes permiso para consultar gestiones Kaufmann.');
        }
    }

    private static BacklogRow mapRow(SObject raw) {
        BacklogRow row = new BacklogRow();
        row.id = (Id) raw.get('Id');
        row.idRef = (String) raw.get('Name');
        row.demanda = (String) raw.get('Demanda__c');
        row.proyecto = (String) raw.get('Proyecto_Principal__c');
        row.descripcion = (String) raw.get('Descripci_n_breve__c');
        row.tipoTarea = (String) raw.get('Tipo_de_Tarea__c');
        row.estado = (String) raw.get('Estado__c');
        row.consultorSeidor = (String) raw.get('Consultor_Seidor__c');
        row.hhTotal = (Decimal) raw.get('HH_Total__c');
        row.fechaInicio = (Date) raw.get('Fecha_de_Inicio__c');
        row.fechaPlanQa = (Date) raw.get('Fecha_Plan_QA__c');
        row.asignacionTarea = (Decimal) raw.get('Asignaci_n_a_la_tarea__c');
        row.avanceReal = (Decimal) raw.get('Avance_Real__c');
        row.recordUrl = '/' + row.id;

        SObject consultorRel = raw.getSObject('Consultor_Kaufmann__r');
        String consultorLookup = consultorRel != null ? (String) consultorRel.get('Name') : null;
        String consultorTexto = (String) raw.get('Consultor_Kaufmann_t__c');
        row.consultorKaufmann = !String.isBlank(consultorLookup) ? consultorLookup : consultorTexto;

        return row;
    }

    private static Boolean isMatch(String value, String expected) {
        return value != null && value.trim().equalsIgnoreCase(expected);
    }

    private static List<String> sortedList(Set<String> values) {
        List<String> sorted = new List<String>(values);
        sorted.sort();
        return sorted;
    }
}
