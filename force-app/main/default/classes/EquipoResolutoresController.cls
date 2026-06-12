public with sharing class EquipoResolutoresController {

    private static final String FIELD_EQUIPO = 'Equipo_Resolutor__c';
    private static final String FIELD_CUSTODIO_CASE = 'Custodio_Actual__c';
    /** API real en org (etiqueta "Estado Ticket"). */
    private static final String FIELD_ESTADO_TICKET = 'Estado_Ticket_del__c';
    private static final String FIELD_ESTADO_COMPLETADO = 'Estado_Completado__c';
    private static final String NOTA_ELIMINADO_EQUIPO = 'Se ha eliminado del equipo';

    public class PicklistOption {
        @AuraEnabled public String label;
        @AuraEnabled public String value;
        public PicklistOption(String label, String value) {
            this.label = label;
            this.value = value;
        }
    }

    public class TeamData {
        @AuraEnabled public String caseNumber;
        @AuraEnabled public Id ownerId;
        @AuraEnabled public String ownerName;
        @AuraEnabled public String ownerPhotoUrl;
        @AuraEnabled public Id currentCustodianId;
        @AuraEnabled public String currentCustodianName;
        @AuraEnabled public Id currentCustodyRecordId;
        @AuraEnabled public Long currentCustodyStartMs;
        @AuraEnabled public Long currentCustodyPauseStartMs;
        @AuraEnabled public Decimal currentCustodyPausedMin;
        @AuraEnabled public String caseStatus;
        @AuraEnabled public String caseSubStatus;
        @AuraEnabled public Boolean custodyPaused;
        @AuraEnabled public List<MemberInfo> members;
    }

    public class SlaAlertInfo {
        @AuraEnabled public Boolean hasAlert;
        @AuraEnabled public String milestoneName;
        @AuraEnabled public String status;
        @AuraEnabled public String message;
        @AuraEnabled public Long minutesRemaining;
        @AuraEnabled public Datetime targetDate;
    }

    public class CustodyHistoryRow {
        @AuraEnabled public Id equipoRecordId;
        @AuraEnabled public String consultantName;
        @AuraEnabled public String equipo;
        @AuraEnabled public String estado;
        @AuraEnabled public String inicioLabel;
        @AuraEnabled public String finLabel;
        @AuraEnabled public String durationLabel;
        @AuraEnabled public String pausedLabel;
        @AuraEnabled public Boolean hadViolation;
        @AuraEnabled public Boolean violationImputed;
    }

    public class SlaFullHistoryRow {
        @AuraEnabled public Id equipoRecordId;
        @AuraEnabled public String entryType;
        @AuraEnabled public String consultantName;
        @AuraEnabled public String rolEquipo;
        @AuraEnabled public String estado;
        @AuraEnabled public String inicioLabel;
        @AuraEnabled public String finLabel;
        @AuraEnabled public String durationLabel;
        @AuraEnabled public String pausedLabel;
        @AuraEnabled public String efectivoLabel;
        @AuraEnabled public String motivoCierre;
        @AuraEnabled public Boolean hadViolation;
        @AuraEnabled public Boolean isOpen;
        /** True solo para el tramo de custodia abierto del responsable activo del ticket. */
        @AuraEnabled public Boolean isCurrentResponsible;
        @AuraEnabled public Long sortKey;
        /** Inicio del tramo (ms) para contador en vivo en el modal. */
        @AuraEnabled public Long inicioMs;
        @AuraEnabled public Decimal pausedMinAccumulated;
        /** Tramo abierto con SLA/custodia en pausa: congelar contador en vivo. */
        @AuraEnabled public Boolean slaPaused;
        @AuraEnabled public Long pauseAnchorMs;
    }

    public class SlaFullHistoryData {
        @AuraEnabled public String caseNumber;
        @AuraEnabled public String ownerName;
        @AuraEnabled public String caseStatus;
        @AuraEnabled public Boolean caseSlaPaused;
        @AuraEnabled public Long casePauseAnchorMs;
        @AuraEnabled public List<SlaFullHistoryRow> rows;
    }

    public class SlaMonitorRow implements Comparable {
        @AuraEnabled public Id caseId;
        @AuraEnabled public String caseNumber;
        @AuraEnabled public String subject;
        @AuraEnabled public String caseStatus;
        @AuraEnabled public String myRole;
        /** true cuando el usuario figura como apoyo formal del equipo (registro sin tramo de custodia). */
        @AuraEnabled public Boolean isApoyoEquipo;
        @AuraEnabled public String recordTypeName;
        @AuraEnabled public String consultantName;
        @AuraEnabled public String responsibleName;
        @AuraEnabled public Id responsibleId;
        @AuraEnabled public Boolean isMyTurn;
        @AuraEnabled public String priority;
        @AuraEnabled public String accountName;
        @AuraEnabled public Datetime createdDate;
        @AuraEnabled public Long ageMinutes;
        @AuraEnabled public String slaStatus;
        @AuraEnabled public String slaLabel;
        @AuraEnabled public String milestoneName;
        @AuraEnabled public Datetime targetDate;
        @AuraEnabled public Long minutesRemaining;
        @AuraEnabled public Integer sortOrder;
        /** SLA detenido (p.ej. SubEstado "Acción Cliente"): el conteo se congela. */
        @AuraEnabled public Boolean isPaused;
        @AuraEnabled public Long pauseStartMs;

        public Integer compareTo(Object other) {
            SlaMonitorRow o = (SlaMonitorRow) other;
            Integer a = this.sortOrder != null ? this.sortOrder : 99;
            Integer b = o.sortOrder != null ? o.sortOrder : 99;
            if (a != b) {
                return a - b;
            }
            String cn = this.caseNumber != null ? this.caseNumber : '';
            String otherCaseNumber = o.caseNumber != null ? o.caseNumber : '';
            return cn.compareTo(otherCaseNumber);
        }
    }

    public class MemberInfo {
        @AuraEnabled public Id userId;
        @AuraEnabled public String userName;
        @AuraEnabled public String photoUrl;
        @AuraEnabled public String role;
        @AuraEnabled public String notes;
        @AuraEnabled public Id membershipRecordId;
        @AuraEnabled public Boolean isCurrentCustodian;
        @AuraEnabled public Boolean isOwner;
        @AuraEnabled public Boolean canEdit;
        @AuraEnabled public Boolean canDelete;
    }

    /** Usuario con permisos de administración SLA (reportería / enlaces a registros). */
    @AuraEnabled(cacheable=true)
    public static Boolean isCurrentUserSlaAdmin() {
        if (!User.SObjectType.getDescribe().fields.getMap().containsKey('Admin_SLA__c')) {
            return false;
        }
        User u = [SELECT Admin_SLA__c FROM User WHERE Id = :UserInfo.getUserId() LIMIT 1];
        return u.Admin_SLA__c == true;
    }

    @AuraEnabled(cacheable=true)
    public static TeamData getTeamData(Id caseId) {
        Case c = [
            SELECT Id, CaseNumber, OwnerId, Status, SubEstado__c, IsStopped, StopStartDate
            FROM Case
            WHERE Id = :caseId
            LIMIT 1
        ];
        TeamData data = new TeamData();
        data.caseNumber = c.CaseNumber;
        data.ownerId = c.OwnerId;
        data.caseStatus = c.Status;
        data.caseSubStatus = c.SubEstado__c;
        data.custodyPaused = (c.IsStopped == true);
        // Si el caso está detenido (p.ej. SubEstado "Acción Cliente"), congelamos
        // el contador desde el instante en que se detuvo el SLA.
        if (c.IsStopped == true && c.StopStartDate != null) {
            data.currentCustodyPauseStartMs = c.StopStartDate.getTime();
        }

        if (String.valueOf(c.OwnerId).startsWith('005')) {
            User u = [SELECT Id, Name, SmallPhotoUrl FROM User WHERE Id = :c.OwnerId LIMIT 1];
            data.ownerName = u.Name;
            data.ownerPhotoUrl = u.SmallPhotoUrl;
        }

        List<Equipo_de_Resolutores__c> registros = [
            SELECT Id, Resolutor__c, Resolutor__r.Name, Resolutor__r.SmallPhotoUrl,
                   Equipo_Resolutor__c, Notas__c, Inicio__c, Fin__c, CreatedDate,
                   Pausa_Inicio__c, Tiempo_Pausado_Min__c
            FROM Equipo_de_Resolutores__c
            WHERE Ticket__c = :caseId
            ORDER BY CreatedDate ASC
        ];

        Map<Id, MemberInfo> memberMap = new Map<Id, MemberInfo>();
        if (String.valueOf(c.OwnerId).startsWith('005')) {
            MemberInfo ownerMi = new MemberInfo();
            ownerMi.userId = c.OwnerId;
            ownerMi.userName = data.ownerName;
            ownerMi.photoUrl = data.ownerPhotoUrl;
            ownerMi.isOwner = true;
            ownerMi.isCurrentCustodian = false;
            ownerMi.canEdit = false;
            ownerMi.canDelete = false;
            memberMap.put(c.OwnerId, ownerMi);
        }

        Equipo_de_Resolutores__c openCustodyRecord;
        for (Equipo_de_Resolutores__c r : registros) {
            if (r.Resolutor__c == null) continue;

            Boolean esApoyo = (r.Inicio__c == null);
            Boolean custodiaAbierta = (r.Inicio__c != null && r.Fin__c == null);
            Boolean soloTramoCerrado = (r.Inicio__c != null && r.Fin__c != null);

            MemberInfo mi = memberMap.get(r.Resolutor__c);
            if (mi == null) {
                if (soloTramoCerrado) {
                    continue;
                }
                mi = new MemberInfo();
                mi.userId = r.Resolutor__c;
                mi.userName = r.Resolutor__r.Name;
                mi.photoUrl = r.Resolutor__r.SmallPhotoUrl;
                mi.isCurrentCustodian = false;
                mi.isOwner = (r.Resolutor__c == c.OwnerId);
                mi.canEdit = false;
                mi.canDelete = false;
                memberMap.put(r.Resolutor__c, mi);
            }

            if (esApoyo) {
                if (isApoyoRemoved(r)) {
                    continue;
                }
                mi.membershipRecordId = r.Id;
                mi.role = r.Equipo_Resolutor__c;
                mi.notes = r.Notas__c;
                mi.canEdit = true;
                mi.canDelete = true;
            }

            if (custodiaAbierta) {
                if (openCustodyRecord == null
                    || r.Inicio__c > openCustodyRecord.Inicio__c) {
                    openCustodyRecord = r;
                }
            }
        }

        if (openCustodyRecord != null) {
            for (MemberInfo mi : memberMap.values()) {
                mi.isCurrentCustodian = (mi.userId == openCustodyRecord.Resolutor__c);
            }
            MemberInfo custodianMi = memberMap.get(openCustodyRecord.Resolutor__c);
            if (custodianMi != null) {
                if (custodianMi.membershipRecordId == null) {
                    custodianMi.membershipRecordId = openCustodyRecord.Id;
                    custodianMi.role = openCustodyRecord.Equipo_Resolutor__c;
                    custodianMi.notes = openCustodyRecord.Notas__c;
                    custodianMi.canEdit = true;
                }
                custodianMi.canDelete = false;
            }
            data.currentCustodianId = openCustodyRecord.Resolutor__c;
            data.currentCustodianName = openCustodyRecord.Resolutor__r.Name;
            data.currentCustodyRecordId = openCustodyRecord.Id;
            data.currentCustodyStartMs = openCustodyRecord.Inicio__c.getTime();
            data.currentCustodyPausedMin = openCustodyRecord.Tiempo_Pausado_Min__c;
            if (openCustodyRecord.Pausa_Inicio__c != null) {
                data.currentCustodyPauseStartMs = openCustodyRecord.Pausa_Inicio__c.getTime();
            } else if (c.IsStopped == true && c.StopStartDate != null) {
                // Pausa por detención del caso (SubEstado que detiene el SLA).
                data.currentCustodyPauseStartMs = c.StopStartDate.getTime();
            } else {
                data.currentCustodyPauseStartMs = null;
            }
            data.custodyPaused = (openCustodyRecord.Pausa_Inicio__c != null)
                || (c.IsStopped == true);
        }

        for (MemberInfo mi : memberMap.values()) {
            if (mi.isCurrentCustodian) {
                mi.canDelete = false;
            }
            if (mi.isOwner) {
                mi.canDelete = false;
            }
            if (mi.membershipRecordId == null) {
                mi.canEdit = false;
                mi.canDelete = false;
            }
        }

        data.members = memberMap.values();
        return data;
    }

    /**
     * SubEstados que detienen el conteo de SLA (y por ende el tiempo de
     * custodia del resolutor/apoyo que tiene el caso en sus manos).
     * TODO mejora 2: mover a Custom Metadata para edicion sin deploy.
     */
    private static final Set<String> PAUSE_SUBSTATUS = new Set<String>{
        'Acci\u00F3n Cliente',
        'Accion Cliente',
        'Acción Cliente'
    };

    private static Boolean isPauseSubStatus(String subStatus) {
        if (String.isBlank(subStatus)) {
            return false;
        }
        return PAUSE_SUBSTATUS.contains(subStatus.trim());
    }

    /**
     * Cierra un tramo en memoria (no hace DML): finaliza cualquier pausa en
     * curso, acumula el tiempo pausado y calcula el tiempo efectivo (bruto
     * menos pausas). El registro debe traer Inicio__c, Pausa_Inicio__c y
     * Tiempo_Pausado_Min__c. Quien llama es responsable del update.
     */
    public static void closeTramoInMemory(Equipo_de_Resolutores__c r) {
        if (r == null) {
            return;
        }
        Datetime nowDt = System.now();
        Decimal pausedMin = r.Tiempo_Pausado_Min__c != null ? r.Tiempo_Pausado_Min__c : 0;
        if (r.Pausa_Inicio__c != null) {
            Long ms = nowDt.getTime() - r.Pausa_Inicio__c.getTime();
            pausedMin += (Decimal.valueOf(ms) / 60000);
            r.Pausa_Inicio__c = null;
        }
        r.Tiempo_Pausado_Min__c = pausedMin;
        r.Fin__c = nowDt;
        if (r.Inicio__c != null) {
            Long grossMin = (nowDt.getTime() - r.Inicio__c.getTime()) / 60000;
            Decimal net = grossMin - pausedMin;
            if (net < 0) {
                net = 0;
            }
            r.Tiempo_Efectivo_Min__c = net;
        }
        if (r.Inicio__c != null) {
            setFieldIfExists(r, FIELD_ESTADO_COMPLETADO, true);
        }
    }

    private static Boolean fieldExists(String apiName) {
        return Equipo_de_Resolutores__c.SObjectType.getDescribe()
            .fields.getMap()
            .containsKey(apiName);
    }

    private static void setFieldIfExists(SObject rec, String apiName, Object value) {
        if (rec == null || !fieldExists(apiName)) {
            return;
        }
        Schema.DescribeFieldResult fieldDesc = Equipo_de_Resolutores__c.SObjectType
            .getDescribe()
            .fields.getMap()
            .get(apiName)
            .getDescribe();
        Boolean inserting = (rec.Id == null);
        if (inserting && !fieldDesc.isCreateable()) {
            return;
        }
        if (!inserting && !fieldDesc.isUpdateable()) {
            return;
        }
        rec.put(apiName, value);
    }

    /**
     * Apoyo dado de baja (registro sin tramo de custodia).
     * Abierto__c en org es fórmula ISBLANK(Fin__c): no se escribe desde Apex.
     */
    private static Boolean isApoyoRemoved(Equipo_de_Resolutores__c r) {
        if (r == null || r.Inicio__c != null) {
            return false;
        }
        if (r.Fin__c != null) {
            return true;
        }
        return String.isNotBlank(r.Notas__c)
            && r.Notas__c.containsIgnoreCase('eliminado del equipo');
    }

    /** Contexto de ticket/especialidad en Equipo_de_Resolutores__c (campos org opcionales). */
    public static void applyEquipoRecordContext(
        Equipo_de_Resolutores__c rec,
        Id caseId,
        String especialidad
    ) {
        if (rec == null || caseId == null) {
            return;
        }
        Case caso = [SELECT Status FROM Case WHERE Id = :caseId LIMIT 1];
        populateEquipoContext(rec, caso, especialidad);
    }

    private static void populateEquipoContext(
        Equipo_de_Resolutores__c rec,
        Case caso,
        String especialidad
    ) {
        if (rec == null) {
            return;
        }
        if (caso != null && String.isNotBlank(caso.Status)) {
            setTicketEstadoOnRecord(rec, caso.Status);
        }
        String esp = especialidad;
        if (String.isBlank(esp) && rec.Ticket__c != null && rec.Resolutor__c != null) {
            esp = resolveEspecialidadForResolutor(rec.Ticket__c, rec.Resolutor__c);
        }
        if (String.isNotBlank(esp)) {
            rec.put(FIELD_EQUIPO, esp);
        }
    }

    private static void setTicketEstadoOnRecord(Equipo_de_Resolutores__c rec, String status) {
        if (rec == null || String.isBlank(status)) {
            return;
        }
        if (fieldExists('Estado__c')) {
            rec.Estado__c = status;
        }
        setFieldIfExists(rec, FIELD_ESTADO_TICKET, status);
        setFieldIfExists(rec, 'Estado_Ticket__c', status);
    }

    /** Especialidad en layout = picklist Equipo_Resolutor__c del registro de apoyo activo. */
    public static String resolveEspecialidadForResolutor(Id caseId, Id userId) {
        if (caseId == null || userId == null) {
            return null;
        }
        List<Equipo_de_Resolutores__c> apoyos = [
            SELECT Equipo_Resolutor__c
            FROM Equipo_de_Resolutores__c
            WHERE Ticket__c = :caseId
              AND Resolutor__c = :userId
              AND Inicio__c = null
              AND Fin__c = null
            ORDER BY CreatedDate DESC
            LIMIT 1
        ];
        if (apoyos.isEmpty()) {
            return null;
        }
        return apoyos[0].Equipo_Resolutor__c;
    }

    @AuraEnabled(cacheable=true)
    public static Id getEquipoRecordTypeIdForCase(Id caseId) {
        return getMatchingRecordTypeId(caseId);
    }

    /** Próximo hito activo del entitlement (alerta SLA en el LWC). */
    @AuraEnabled(cacheable=true)
    public static SlaAlertInfo getSlaAlert(Id caseId) {
        SlaAlertInfo info = new SlaAlertInfo();
        info.hasAlert = false;
        info.status = 'ok';
        if (caseId == null) {
            return info;
        }

        List<CaseMilestone> milestones;
        try {
            milestones = [
                SELECT Id, MilestoneType.Name, TargetDate, IsCompleted, IsViolated
                FROM CaseMilestone
                WHERE CaseId = :caseId
                  AND IsCompleted = false
                ORDER BY TargetDate ASC NULLS LAST
                LIMIT 10
            ];
        } catch (Exception e) {
            return info;
        }

        if (milestones == null || milestones.isEmpty()) {
            return info;
        }

        CaseMilestone nextMs = milestones[0];
        for (CaseMilestone ms : milestones) {
            if (ms.IsViolated == true) {
                nextMs = ms;
                break;
            }
        }

        info.hasAlert = true;
        info.milestoneName = nextMs.MilestoneType.Name;
        info.targetDate = nextMs.TargetDate;

        // Si el caso está detenido, congelamos la evaluación en ese instante
        // para no marcar infracción mientras el SLA no corre.
        Long refMs = System.now().getTime();
        for (Case c : [
            SELECT IsStopped, StopStartDate FROM Case WHERE Id = :caseId LIMIT 1
        ]) {
            if (c.IsStopped == true && c.StopStartDate != null) {
                refMs = c.StopStartDate.getTime();
            }
        }

        applyMilestoneToAlert(info, nextMs, refMs);
        return info;
    }

    /** Tickets abiertos del usuario como resolutor (owner) o apoyo formal del equipo. */
    @AuraEnabled
    public static List<SlaMonitorRow> getSlaMonitorForCurrentUser() {
        Id userId = UserInfo.getUserId();
        Map<Id, SlaMonitorRow> rowsByCase = new Map<Id, SlaMonitorRow>();

        for (Case c : [
            SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate,
                   Account.Name, RecordType.DeveloperName
            FROM Case
            WHERE OwnerId = :userId AND IsClosed = false
            ORDER BY LastModifiedDate DESC
            LIMIT 40
        ]) {
            SlaMonitorRow row = buildMonitorRow(c, 'Resolutor');
            row.isApoyoEquipo = false;
            rowsByCase.put(c.Id, row);
        }

        Map<Id, Equipo_de_Resolutores__c> apoyoByCase = new Map<Id, Equipo_de_Resolutores__c>();
        for (Equipo_de_Resolutores__c er : [
            SELECT Ticket__c, Ticket__r.CaseNumber, Ticket__r.Subject, Ticket__r.Status,
                   Ticket__r.IsClosed, Ticket__r.Priority, Ticket__r.CreatedDate,
                   Ticket__r.Account.Name, Ticket__r.RecordType.DeveloperName, Inicio__c
            FROM Equipo_de_Resolutores__c
            WHERE Resolutor__c = :userId
              AND Ticket__c != null
              AND Inicio__c = null
            ORDER BY LastModifiedDate DESC
            LIMIT 200
        ]) {
            if (er.Ticket__r == null || er.Ticket__r.IsClosed == true) {
                continue;
            }
            if (!apoyoByCase.containsKey(er.Ticket__c)) {
                apoyoByCase.put(er.Ticket__c, er);
            }
        }

        for (Id caseId : apoyoByCase.keySet()) {
            if (rowsByCase.containsKey(caseId)) {
                continue;
            }
            Equipo_de_Resolutores__c er = apoyoByCase.get(caseId);
            SlaMonitorRow row = new SlaMonitorRow();
            row.caseId = er.Ticket__c;
            row.caseNumber = er.Ticket__r.CaseNumber;
            row.subject = truncate(er.Ticket__r.Subject, 80);
            row.caseStatus = er.Ticket__r.Status;
            row.priority = er.Ticket__r.Priority;
            row.accountName = er.Ticket__r.Account != null ? er.Ticket__r.Account.Name : null;
            row.createdDate = er.Ticket__r.CreatedDate;
            row.myRole = 'Apoyo';
            row.isApoyoEquipo = true;
            row.recordTypeName = er.Ticket__r.RecordType != null
                ? er.Ticket__r.RecordType.DeveloperName
                : null;
            rowsByCase.put(caseId, row);
        }

        return finalizeMonitorRows(rowsByCase);
    }

    public class WorkloadRow {
        @AuraEnabled public Id userId;
        @AuraEnabled public String userName;
        @AuraEnabled public Integer total;
        @AuraEnabled public Integer criticos;
    }

    /**
     * Carga de trabajo por consultor del equipo directo: cuantos tickets
     * tiene cada uno en sus manos (custodia activa) y cuantos estan criticos.
     */
    @AuraEnabled
    public static List<WorkloadRow> getTeamWorkload() {
        Map<String, WorkloadRow> byUser = new Map<String, WorkloadRow>();

        for (SlaMonitorRow r : getSlaMonitorForMyTeam()) {
            Id uId = r.responsibleId;
            String uName = r.responsibleName != null ? r.responsibleName : r.consultantName;
            String key = uId != null ? String.valueOf(uId)
                : (String.isNotBlank(uName) ? uName : 'sin');

            WorkloadRow w = byUser.get(key);
            if (w == null) {
                w = new WorkloadRow();
                w.userId = uId;
                w.userName = uName != null ? uName : 'Sin responsable';
                w.total = 0;
                w.criticos = 0;
                byUser.put(key, w);
            }
            w.total++;
            if (r.slaStatus == 'violated') {
                w.criticos++;
            }
        }

        return byUser.values();
    }

    @AuraEnabled(cacheable=true)
    public static Boolean currentUserHasTeam() {
        return ![
            SELECT Id FROM User
            WHERE ManagerId = :UserInfo.getUserId() AND IsActive = true
            LIMIT 1
        ].isEmpty();
    }

    /** Tickets abiertos del equipo directo (subordinados por ManagerId). */
    @AuraEnabled(cacheable=true)
    public static List<SlaMonitorRow> getSlaMonitorForMyTeam() {
        Set<Id> teamUserIds = new Set<Id>();
        for (User u : [
            SELECT Id FROM User
            WHERE ManagerId = :UserInfo.getUserId() AND IsActive = true
            LIMIT 100
        ]) {
            teamUserIds.add(u.Id);
        }
        if (teamUserIds.isEmpty()) {
            return new List<SlaMonitorRow>();
        }

        Map<Id, SlaMonitorRow> rowsByCase = new Map<Id, SlaMonitorRow>();

        for (Case c : [
            SELECT Id, CaseNumber, Subject, Status, OwnerId, Owner.Name,
                   Priority, CreatedDate, Account.Name
            FROM Case
            WHERE OwnerId IN :teamUserIds AND IsClosed = false
            ORDER BY LastModifiedDate DESC
            LIMIT 80
        ]) {
            SlaMonitorRow row = buildMonitorRow(c, 'Resolutor');
            row.consultantName = c.Owner.Name;
            rowsByCase.put(c.Id, row);
        }

        for (Equipo_de_Resolutores__c er : [
            SELECT Ticket__c, Ticket__r.CaseNumber, Ticket__r.Subject, Ticket__r.Status,
                   Ticket__r.IsClosed, Ticket__r.Priority, Ticket__r.CreatedDate,
                   Ticket__r.Account.Name, Resolutor__r.Name, Inicio__c, Fin__c
            FROM Equipo_de_Resolutores__c
            WHERE Resolutor__c IN :teamUserIds AND Ticket__c != null
            ORDER BY LastModifiedDate DESC
            LIMIT 300
        ]) {
            if (er.Ticket__r == null || er.Ticket__r.IsClosed == true) {
                continue;
            }
            String rol = (er.Inicio__c != null && er.Fin__c == null) ? 'Responsable' : 'Apoyo';
            if (rowsByCase.containsKey(er.Ticket__c)) {
                SlaMonitorRow existing = rowsByCase.get(er.Ticket__c);
                if (rol == 'Responsable') {
                    existing.myRole = 'Responsable';
                    existing.consultantName = er.Resolutor__r.Name;
                }
                continue;
            }
            SlaMonitorRow row = new SlaMonitorRow();
            row.caseId = er.Ticket__c;
            row.caseNumber = er.Ticket__r.CaseNumber;
            row.subject = truncate(er.Ticket__r.Subject, 80);
            row.caseStatus = er.Ticket__r.Status;
            row.priority = er.Ticket__r.Priority;
            row.accountName = er.Ticket__r.Account != null ? er.Ticket__r.Account.Name : null;
            row.createdDate = er.Ticket__r.CreatedDate;
            row.myRole = rol;
            row.consultantName = er.Resolutor__r.Name;
            rowsByCase.put(er.Ticket__c, row);
        }

        return finalizeMonitorRows(rowsByCase);
    }

    private static List<SlaMonitorRow> finalizeMonitorRows(Map<Id, SlaMonitorRow> rowsByCase) {
        if (rowsByCase == null || rowsByCase.isEmpty()) {
            return new List<SlaMonitorRow>();
        }
        Map<Id, CaseMilestone> milestoneByCase = getActiveMilestoneByCase(rowsByCase.keySet());
        Map<Id, Map<String, Object>> responsibleByCase = getResponsibleByCase(rowsByCase.keySet());
        Map<Id, Case> pauseByCase = getPauseInfoByCase(rowsByCase.keySet());
        Id currentUserId = UserInfo.getUserId();

        List<SlaMonitorRow> result = new List<SlaMonitorRow>();
        for (SlaMonitorRow row : rowsByCase.values()) {
            Case pc = pauseByCase.get(row.caseId);
            row.isPaused = (pc != null && pc.IsStopped == true);
            row.pauseStartMs = (row.isPaused && pc.StopStartDate != null)
                ? pc.StopStartDate.getTime()
                : null;

            CaseMilestone ms = milestoneByCase.get(row.caseId);
            if (ms != null) {
                SlaAlertInfo alert = new SlaAlertInfo();
                Long refMs = (row.isPaused && row.pauseStartMs != null)
                    ? row.pauseStartMs
                    : System.now().getTime();
                applyMilestoneToAlert(alert, ms, refMs);
                row.slaStatus = alert.status;
                row.slaLabel = alert.message;
                row.milestoneName = alert.milestoneName;
                row.targetDate = alert.targetDate;
                row.minutesRemaining = alert.minutesRemaining;
                row.sortOrder = slaSortOrder(alert.status);
            } else {
                row.slaStatus = 'ok';
                row.slaLabel = 'Sin hito activo';
                row.milestoneName = '';
                row.sortOrder = 4;
            }

            Map<String, Object> resp = responsibleByCase.get(row.caseId);
            if (resp != null) {
                row.responsibleId = (Id) resp.get('id');
                row.responsibleName = (String) resp.get('name');
            }
            row.isMyTurn = (row.responsibleId == currentUserId);

            if (row.createdDate != null) {
                row.ageMinutes = (System.now().getTime() - row.createdDate.getTime()) / 60000;
            }

            result.add(row);
        }
        result.sort();
        return result;
    }

    /** Estado de detención (IsStopped/StopStartDate) por Case para congelar SLA. */
    private static Map<Id, Case> getPauseInfoByCase(Set<Id> caseIds) {
        Map<Id, Case> result = new Map<Id, Case>();
        if (caseIds == null || caseIds.isEmpty()) {
            return result;
        }
        for (Case c : [
            SELECT Id, IsStopped, StopStartDate
            FROM Case
            WHERE Id IN :caseIds
        ]) {
            result.put(c.Id, c);
        }
        return result;
    }

    /** Obtiene el Resolutor con tramo abierto (custodia activa) por Case. */
    private static Map<Id, Map<String, Object>> getResponsibleByCase(Set<Id> caseIds) {
        Map<Id, Map<String, Object>> result = new Map<Id, Map<String, Object>>();
        if (caseIds == null || caseIds.isEmpty()) {
            return result;
        }
        for (Equipo_de_Resolutores__c er : [
            SELECT Ticket__c, Resolutor__c, Resolutor__r.Name, Inicio__c
            FROM Equipo_de_Resolutores__c
            WHERE Ticket__c IN :caseIds
              AND Inicio__c != null
              AND Fin__c = null
            ORDER BY Inicio__c DESC
        ]) {
            if (!result.containsKey(er.Ticket__c)) {
                Map<String, Object> info = new Map<String, Object>();
                info.put('id', er.Resolutor__c);
                info.put('name', er.Resolutor__r != null ? er.Resolutor__r.Name : null);
                result.put(er.Ticket__c, info);
            }
        }
        return result;
    }

    private static SlaMonitorRow buildMonitorRow(Case c, String role) {
        SlaMonitorRow row = new SlaMonitorRow();
        row.caseId = c.Id;
        row.caseNumber = c.CaseNumber;
        row.subject = truncate(c.Subject, 80);
        row.caseStatus = c.Status;
        row.priority = c.Priority;
        row.createdDate = c.CreatedDate;
        row.accountName = c.Account != null ? c.Account.Name : null;
        row.myRole = role;
        row.isApoyoEquipo = false;
        row.recordTypeName = c.RecordType != null ? c.RecordType.DeveloperName : null;
        row.consultantName = '';
        return row;
    }

    private static Map<Id, CaseMilestone> getActiveMilestoneByCase(Set<Id> caseIds) {
        Map<Id, CaseMilestone> result = new Map<Id, CaseMilestone>();
        if (caseIds == null || caseIds.isEmpty()) {
            return result;
        }
        try {
            for (CaseMilestone ms : [
                SELECT CaseId, MilestoneType.Name, TargetDate, IsCompleted, IsViolated
                FROM CaseMilestone
                WHERE CaseId IN :caseIds AND IsCompleted = false
                ORDER BY TargetDate ASC NULLS LAST
            ]) {
                if (!result.containsKey(ms.CaseId)) {
                    result.put(ms.CaseId, ms);
                } else if (ms.IsViolated == true) {
                    result.put(ms.CaseId, ms);
                }
            }
        } catch (Exception e) {
            return result;
        }
        return result;
    }

    private static void applyMilestoneToAlert(SlaAlertInfo info, CaseMilestone nextMs) {
        applyMilestoneToAlert(info, nextMs, System.now().getTime());
    }

    /**
     * Clasifica el estado SLA respecto a una referencia temporal.
     * - refMs permite congelar el cálculo cuando el caso está detenido (pausado),
     *   evitando "vencidos" falsos mientras el SLA no corre.
     * - Si el hito ya pasó su objetivo (o el milestone está marcado violado), se
     *   considera "violated" (Infracción); no usamos un estado "danger" separado.
     */
    private static void applyMilestoneToAlert(SlaAlertInfo info, CaseMilestone nextMs, Long refMs) {
        info.milestoneName = nextMs.MilestoneType.Name;
        info.targetDate = nextMs.TargetDate;

        if (nextMs.IsViolated == true) {
            info.status = 'violated';
            info.message = 'SLA en infraccion';
            info.minutesRemaining = 0;
            return;
        }

        if (nextMs.TargetDate != null) {
            Long diffMs = nextMs.TargetDate.getTime() - refMs;
            info.minutesRemaining = diffMs / 60000;
            if (info.minutesRemaining <= 0) {
                info.status = 'violated';
                info.message = 'SLA en infraccion';
            } else if (info.minutesRemaining <= 60) {
                info.status = 'warning';
                info.message = 'Vence en ' + info.minutesRemaining + ' min';
            } else {
                info.status = 'ok';
                Long hours = info.minutesRemaining / 60;
                info.message = 'Vence en ~' + hours + ' h';
            }
        } else {
            info.status = 'ok';
            info.message = 'Hito activo';
        }
    }

    /** Marca infracción en el tramo abierto (desde trigger de CaseMilestone). */
    public static void imputeViolationToOpenCustody(Set<Id> caseIds) {
        if (caseIds == null || caseIds.isEmpty()) {
            return;
        }
        List<Equipo_de_Resolutores__c> tramos = [
            SELECT Id, Tuvo_infraccion_SLA__c, Infraccion_imputada__c
            FROM Equipo_de_Resolutores__c
            WHERE Ticket__c IN :caseIds
              AND Inicio__c != null
              AND Fin__c = null
        ];
        if (tramos.isEmpty()) {
            return;
        }
        for (Equipo_de_Resolutores__c t : tramos) {
            t.Tuvo_infraccion_SLA__c = true;
            t.Infraccion_imputada__c = true;
        }
        update tramos;
        for (Id caseId : caseIds) {
            EquipoResolutoresRealtimePublisher.requestPublish(
                caseId,
                EquipoResolutoresRealtimePublisher.TYPE_SLA,
                null
            );
        }
        EquipoResolutoresRealtimePublisher.flushPending();
    }

    private static Integer slaSortOrder(String status) {
        if (status == 'violated' || status == 'danger') return 0;
        if (status == 'warning') return 2;
        if (status == 'ok') return 3;
        return 4;
    }

    private static String truncate(String text, Integer maxLen) {
        if (text == null) return '';
        if (text.length() <= maxLen) return text;
        return text.substring(0, maxLen - 3) + '...';
    }

    /** Historial de tramos con custodia (Inicio poblado). */
    @AuraEnabled(cacheable=true)
    public static List<CustodyHistoryRow> getCustodyHistory(Id caseId) {
        List<CustodyHistoryRow> rows = new List<CustodyHistoryRow>();
        if (caseId == null) {
            return rows;
        }

        List<Equipo_de_Resolutores__c> tramos = [
            SELECT Resolutor__r.Name, Equipo_Resolutor__c, Estado__c, Inicio__c, Fin__c,
                   Pausa_Inicio__c, Tiempo_Pausado_Min__c, Tuvo_infraccion_SLA__c,
                   Infraccion_imputada__c
            FROM Equipo_de_Resolutores__c
            WHERE Ticket__c = :caseId AND Inicio__c != null
            ORDER BY Inicio__c DESC
            LIMIT 50
        ];

        for (Equipo_de_Resolutores__c t : tramos) {
            Decimal pausedMin = t.Tiempo_Pausado_Min__c != null ? t.Tiempo_Pausado_Min__c : 0;
            if (t.Pausa_Inicio__c != null) {
                Long ms = System.now().getTime() - t.Pausa_Inicio__c.getTime();
                pausedMin += (Decimal.valueOf(ms) / 60000);
            }

            CustodyHistoryRow row = new CustodyHistoryRow();
            row.equipoRecordId = t.Id;
            row.consultantName = t.Resolutor__r.Name;
            row.equipo = t.Equipo_Resolutor__c;
            row.estado = t.Estado__c;
            row.inicioLabel = formatDateTime(t.Inicio__c);
            row.finLabel = t.Fin__c != null ? formatDateTime(t.Fin__c) : 'En curso';
            row.durationLabel = formatDurationMinutes(t.Inicio__c, t.Fin__c, pausedMin);
            if (pausedMin >= 1) {
                row.pausedLabel = 'Pausa ' + formatMinutes((Long) pausedMin.round());
            }
            row.hadViolation = t.Tuvo_infraccion_SLA__c == true;
            row.violationImputed = t.Infraccion_imputada__c == true;
            rows.add(row);
        }
        return rows;
    }

    /**
     * Historial completo del ticket para reportería: tramos de custodia (Estado__c, tiempos)
     * y registros de apoyo en equipo de resolutores.
     */
    @AuraEnabled
    public static SlaFullHistoryData getSlaTicketFullHistory(Id caseId) {
        return new EquipoResolutoresHistoryLoader().load(caseId);
    }

    /**
     * Historial sin restricción de sharing en Equipo_de_Resolutores__c (solo lectura),
     * para que el monitor SLA muestre los mismos registros que en el Case.
     */
    private without sharing class EquipoResolutoresHistoryLoader {
        public SlaFullHistoryData load(Id caseId) {
        SlaFullHistoryData data = new SlaFullHistoryData();
        data.rows = new List<SlaFullHistoryRow>();
        if (caseId == null) {
            return data;
        }

        List<Case> casos = [
            SELECT CaseNumber, Status, IsStopped, StopStartDate, Owner.Name
            FROM Case
            WHERE Id = :caseId
            LIMIT 1
        ];
        if (casos.isEmpty()) {
            return data;
        }
        Case c = casos[0];
        data.caseNumber = c.CaseNumber;
        data.caseStatus = c.Status;
        data.ownerName = c.Owner != null ? c.Owner.Name : null;
        data.caseSlaPaused = (c.IsStopped == true);
        data.casePauseAnchorMs = (c.IsStopped == true && c.StopStartDate != null)
            ? c.StopStartDate.getTime()
            : null;

        List<Equipo_de_Resolutores__c> registros = queryEquipoForTicketHistory(caseId);

        Id currentCustodianId = null;
        Datetime latestOpenInicio;
        for (Equipo_de_Resolutores__c t : registros) {
            if (t.Inicio__c != null && t.Fin__c == null) {
                if (latestOpenInicio == null || t.Inicio__c > latestOpenInicio) {
                    latestOpenInicio = t.Inicio__c;
                    currentCustodianId = t.Resolutor__c;
                }
            }
        }

        for (Equipo_de_Resolutores__c t : registros) {
            SlaFullHistoryRow row = new SlaFullHistoryRow();
            row.equipoRecordId = t.Id;
            row.consultantName = t.Resolutor__r != null ? t.Resolutor__r.Name : 'Consultor';
            row.rolEquipo = t.Equipo_Resolutor__c;
            row.estado = estadoTicketFromRecord(t);
            row.motivoCierre = t.Motivo_Cierre__c;
            row.hadViolation = t.Tuvo_infraccion_SLA__c == true;

            if (t.Inicio__c != null) {
                row.entryType = 'Custodia';
                Decimal pausedMin = t.Tiempo_Pausado_Min__c != null ? t.Tiempo_Pausado_Min__c : 0;
                if (t.Pausa_Inicio__c != null) {
                    Long ms = System.now().getTime() - t.Pausa_Inicio__c.getTime();
                    pausedMin += (Decimal.valueOf(ms) / 60000);
                }
                row.inicioLabel = formatDateTime(t.Inicio__c);
                row.isOpen = (t.Fin__c == null);
                row.isCurrentResponsible = row.isOpen
                    && currentCustodianId != null
                    && t.Resolutor__c == currentCustodianId;
                row.finLabel = row.isOpen ? 'En curso' : formatDateTime(t.Fin__c);
                row.inicioMs = t.Inicio__c.getTime();
                row.pausedMinAccumulated = pausedMin;
                row.slaPaused = false;
                row.pauseAnchorMs = null;
                if (row.isOpen) {
                    if (t.Pausa_Inicio__c != null) {
                        row.slaPaused = true;
                        row.pauseAnchorMs = t.Pausa_Inicio__c.getTime();
                    } else if (data.caseSlaPaused == true && data.casePauseAnchorMs != null) {
                        row.slaPaused = true;
                        row.pauseAnchorMs = data.casePauseAnchorMs;
                    }
                }
                row.durationLabel = formatDurationMinutes(t.Inicio__c, t.Fin__c, pausedMin);
                if (pausedMin >= 1) {
                    row.pausedLabel = 'Pausa ' + formatMinutes((Long) pausedMin.round());
                }
                if (row.slaPaused == true) {
                    row.pausedLabel = String.isNotBlank(row.pausedLabel)
                        ? row.pausedLabel + ' · SLA pausado'
                        : 'SLA pausado';
                }
                if (t.Tiempo_Efectivo_Min__c != null && t.Tiempo_Efectivo_Min__c > 0) {
                    row.efectivoLabel = 'Tiempo efectivo ' + formatMinutes(t.Tiempo_Efectivo_Min__c.longValue());
                }
                row.sortKey = t.Inicio__c.getTime();
            } else {
                row.entryType = 'Apoyo';
                row.inicioLabel = formatDateTime(t.CreatedDate);
                Boolean removed = isApoyoRemoved(t);
                row.isOpen = false;
                row.isCurrentResponsible = false;
                if (removed) {
                    row.finLabel = t.Fin__c != null
                        ? formatDateTime(t.Fin__c)
                        : formatDateTime(t.CreatedDate);
                    row.durationLabel = NOTA_ELIMINADO_EQUIPO;
                } else {
                    row.finLabel = 'En equipo';
                    row.durationLabel = 'Se a\u00F1ade nuevo miembro al equipo';
                }
                if (String.isNotBlank(t.Notas__c) && !removed) {
                    row.pausedLabel = truncate(t.Notas__c, 120);
                }
                row.sortKey = t.CreatedDate != null
                    ? t.CreatedDate.getTime()
                    : System.now().getTime();
            }
            data.rows.add(row);
        }

        data.rows.sort(new SlaFullHistoryRowComparator());
        return data;
        }
    }

    private static List<Equipo_de_Resolutores__c> queryEquipoForTicketHistory(Id caseId) {
        String fields =
            'Id, Resolutor__c, Resolutor__r.Name, Equipo_Resolutor__c, Estado__c, '
            + 'Inicio__c, Fin__c, CreatedDate, Pausa_Inicio__c, Tiempo_Pausado_Min__c, '
            + 'Tiempo_Efectivo_Min__c, Tuvo_infraccion_SLA__c, Motivo_Cierre__c, Notas__c';
        if (fieldExists(FIELD_ESTADO_TICKET)) {
            fields += ', ' + FIELD_ESTADO_TICKET;
        }
        String soql =
            'SELECT ' + fields
            + ' FROM Equipo_de_Resolutores__c WHERE Ticket__c = :caseId '
            + 'ORDER BY CreatedDate ASC LIMIT 200';
        return Database.query(soql);
    }

    private static String estadoTicketFromRecord(Equipo_de_Resolutores__c t) {
        if (String.isNotBlank(t.Estado__c)) {
            return t.Estado__c;
        }
        if (fieldExists(FIELD_ESTADO_TICKET)) {
            Object v = t.get(FIELD_ESTADO_TICKET);
            return v != null ? String.valueOf(v) : null;
        }
        return null;
    }

    private class SlaFullHistoryRowComparator implements Comparator<SlaFullHistoryRow> {
        public Integer compare(SlaFullHistoryRow a, SlaFullHistoryRow b) {
            Long ak = a.sortKey != null ? a.sortKey : 0;
            Long bk = b.sortKey != null ? b.sortKey : 0;
            if (ak == bk) return 0;
            return ak > bk ? -1 : 1;
        }
    }

    public class TimelineSegment {
        @AuraEnabled public String consultantName;
        @AuraEnabled public String estado;
        @AuraEnabled public Long startMs;
        @AuraEnabled public Long endMs;
        @AuraEnabled public Decimal pausedMin;
        @AuraEnabled public Boolean isActive;
        @AuraEnabled public Boolean isGap;
        @AuraEnabled public String startLabel;
        @AuraEnabled public String endLabel;
    }

    public class TimelineData {
        @AuraEnabled public Long startMs;
        @AuraEnabled public Long endMs;
        @AuraEnabled public List<TimelineSegment> segments;
    }

    /**
     * Linea de tiempo de custodia: tramos secuenciales por consultor mas los
     * huecos sin responsable. Pensado para visualizacion proporcional.
     */
    @AuraEnabled(cacheable=true)
    public static TimelineData getCustodyTimeline(Id caseId) {
        TimelineData data = new TimelineData();
        data.segments = new List<TimelineSegment>();
        if (caseId == null) {
            return data;
        }

        List<Equipo_de_Resolutores__c> tramos = [
            SELECT Resolutor__r.Name, Estado__c, Inicio__c, Fin__c,
                   Pausa_Inicio__c, Tiempo_Pausado_Min__c
            FROM Equipo_de_Resolutores__c
            WHERE Ticket__c = :caseId AND Inicio__c != null
            ORDER BY Inicio__c ASC
            LIMIT 50
        ];
        if (tramos.isEmpty()) {
            return data;
        }

        Long nowMs = System.now().getTime();
        Long firstStart = tramos[0].Inicio__c.getTime();
        Long lastEnd = firstStart;

        Long prevEnd = null;
        for (Equipo_de_Resolutores__c t : tramos) {
            Long startMs = t.Inicio__c.getTime();
            Long endMs = t.Fin__c != null ? t.Fin__c.getTime() : nowMs;
            if (endMs < startMs) {
                endMs = startMs;
            }

            if (prevEnd != null && startMs > prevEnd) {
                TimelineSegment gap = new TimelineSegment();
                gap.isGap = true;
                gap.startMs = prevEnd;
                gap.endMs = startMs;
                gap.consultantName = 'Sin responsable';
                data.segments.add(gap);
            }

            Decimal pausedMin = t.Tiempo_Pausado_Min__c != null ? t.Tiempo_Pausado_Min__c : 0;
            if (t.Pausa_Inicio__c != null) {
                pausedMin += (Decimal.valueOf(nowMs - t.Pausa_Inicio__c.getTime()) / 60000);
            }

            TimelineSegment seg = new TimelineSegment();
            seg.isGap = false;
            seg.consultantName = t.Resolutor__r != null ? t.Resolutor__r.Name : 'Consultor';
            seg.estado = t.Estado__c;
            seg.startMs = startMs;
            seg.endMs = endMs;
            seg.pausedMin = pausedMin;
            seg.isActive = (t.Fin__c == null);
            seg.startLabel = formatDateTime(t.Inicio__c);
            seg.endLabel = t.Fin__c != null ? formatDateTime(t.Fin__c) : 'En curso';
            data.segments.add(seg);

            prevEnd = endMs;
            if (endMs > lastEnd) {
                lastEnd = endMs;
            }
        }

        data.startMs = firstStart;
        data.endMs = lastEnd;
        return data;
    }

    private static String formatDateTime(Datetime dt) {
        if (dt == null) return '';
        return dt.format('dd/MM/yyyy HH:mm');
    }

    private static String formatDurationMinutes(Datetime inicio, Datetime fin, Decimal pausedMin) {
        if (inicio == null) return '';
        Datetime endDt = fin != null ? fin : System.now();
        Long grossMins = ((endDt.getTime() - inicio.getTime()) / 60000);
        Long paused = pausedMin != null ? (Long) pausedMin.round() : 0;
        Long netMins = grossMins - paused;
        if (netMins < 0) netMins = 0;
        return formatMinutes(netMins);
    }

    private static String formatMinutes(Long mins) {
        if (mins == null) mins = 0;
        Long h = mins / 60;
        Long m = Math.mod(mins, 60);
        if (h > 0) {
            return h + ' h ' + m + ' min';
        }
        return m + ' min';
    }

    /** Valores reales del picklist Equipo resolutores (API Equipo_Resolutor__c). */
    @AuraEnabled(cacheable=true)
    public static List<PicklistOption> getRoleOptions(Id caseId) {
        List<PicklistOption> opts = new List<PicklistOption>();
        Schema.DescribeFieldResult fieldDesc = Equipo_de_Resolutores__c.Equipo_Resolutor__c.getDescribe();
        for (Schema.PicklistEntry pe : fieldDesc.getPicklistValues()) {
            if (pe.isActive()) {
                opts.add(new PicklistOption(pe.getLabel(), pe.getValue()));
            }
        }
        return opts;
    }

    /** Status de cierre/cancelación: sin nuevo tramo de custodia ni mutaciones SLA. */
    @TestVisible
    public static Boolean isClosureStatus(String status) {
        if (String.isBlank(status)) {
            return false;
        }
        if (status == 'Cierre' || status == 'Cerrado' || status == 'Closed'
            || status == 'Cancelado' || status == 'Cancelled') {
            return true;
        }
        String lower = status.toLowerCase();
        return lower.contains('cerrad') || lower.contains('closed')
            || lower.contains('cancel');
    }

    /** Caso cerrado para efectos de SLA/custodia (IsClosed o Status de cierre). */
    @TestVisible
    public static Boolean isCaseClosedForSla(Case c) {
        if (c == null) {
            return false;
        }
        return c.IsClosed == true || isClosureStatus(c.Status);
    }

    /**
     * Rellena Estado__c en tramos de custodia que quedaron vacíos (p. ej. antes
     * de registrar estado en transferCustody). Usar en Execute Anonymous:
     * Integer n = EquipoResolutoresController.backfillMissingCustodyEstado(500);
     */
    public static Integer backfillMissingCustodyEstado(Integer rowLimit) {
        Integer lim = (rowLimit != null && rowLimit > 0) ? rowLimit : 200;
        List<Equipo_de_Resolutores__c> rows = [
            SELECT Id, Estado__c, Ticket__r.Status
            FROM Equipo_de_Resolutores__c
            WHERE Inicio__c != null
              AND Estado__c = null
              AND Ticket__c != null
            LIMIT :lim
        ];
        for (Equipo_de_Resolutores__c r : rows) {
            if (r.Ticket__r != null && String.isNotBlank(r.Ticket__r.Status)) {
                r.Estado__c = r.Ticket__r.Status;
            }
        }
        if (!rows.isEmpty()) {
            update rows;
        }
        return rows.size();
    }

    /**
     * Bloquea cambios de equipo/custodia cuando el caso ya está cerrado: sin
     * entitlement activo no debe modificarse el SLA ni los responsables.
     */
    private static void assertCaseOpen(Id caseId) {
        if (caseId == null) {
            return;
        }
        Case c = [SELECT IsClosed, Status FROM Case WHERE Id = :caseId LIMIT 1];
        if (isCaseClosedForSla(c)) {
            throw new AuraHandledException(
                'El ticket está cerrado. No se pueden modificar responsables ni el SLA.'
            );
        }
    }

    @AuraEnabled
    public static Id addMember(Id caseId, Id userId, String role) {
        if (caseId == null || userId == null) {
            throw new AuraHandledException('Seleccioná un usuario válido.');
        }
        if (String.isBlank(role)) {
            throw new AuraHandledException('Seleccioná la especialidad.');
        }
        assertCaseOpen(caseId);

        List<Equipo_de_Resolutores__c> existentes = [
            SELECT Id FROM Equipo_de_Resolutores__c
            WHERE Ticket__c = :caseId AND Resolutor__c = :userId LIMIT 1
        ];
        if (!existentes.isEmpty()) {
            throw new AuraHandledException('Ese usuario ya está en el equipo de este ticket.');
        }

        Case caso = [SELECT Status FROM Case WHERE Id = :caseId LIMIT 1];
        Equipo_de_Resolutores__c nuevo = new Equipo_de_Resolutores__c(
            Ticket__c = caseId,
            Resolutor__c = userId
        );
        populateEquipoContext(nuevo, caso, role);
        nuevo.RecordTypeId = getMatchingRecordTypeId(caseId);

        try {
            insert nuevo;
        } catch (DmlException e) {
            throw new AuraHandledException(parseDmlMessage(e));
        }
        EquipoResolutoresRealtimePublisher.publishNow(
            caseId,
            EquipoResolutoresRealtimePublisher.TYPE_TEAM,
            null
        );
        return nuevo.Id;
    }

    private static String parseDmlMessage(DmlException e) {
        if (e.getNumDml() == 0) {
            return e.getMessage();
        }
        return e.getDmlMessage(0);
    }

    @AuraEnabled
    public static void releaseCustody(Id caseId, String motivo) {
        Id ownerId = resolveCaseOwnerUserId(caseId);
        transferCustody(caseId, ownerId, motivo);
    }

    @AuraEnabled
    public static void transferCustody(Id caseId, Id newCustodianUserId, String motivo) {
        assertCaseOpen(caseId);

        List<Equipo_de_Resolutores__c> abiertos = [
            SELECT Id, Inicio__c, Pausa_Inicio__c, Tiempo_Pausado_Min__c
            FROM Equipo_de_Resolutores__c
            WHERE Ticket__c = :caseId AND Inicio__c != null AND Fin__c = null
        ];
        for (Equipo_de_Resolutores__c r : abiertos) {
            closeTramoInMemory(r);
            if (String.isNotBlank(motivo)) {
                r.Motivo_Cierre__c = motivo;
            }
        }
        if (!abiertos.isEmpty()) update abiertos;

        Case casoCtx = [SELECT Status FROM Case WHERE Id = :caseId LIMIT 1];
        Equipo_de_Resolutores__c nuevo = new Equipo_de_Resolutores__c(
            Ticket__c = caseId,
            Resolutor__c = newCustodianUserId,
            Inicio__c = System.now()
        );
        populateEquipoContext(nuevo, casoCtx, null);
        nuevo.RecordTypeId = getMatchingRecordTypeId(caseId);
        try {
            insert nuevo;
            syncCaseCustodian(caseId, newCustodianUserId);
        } catch (DmlException e) {
            throw new AuraHandledException(parseDmlMessage(e));
        }
        EquipoResolutoresRealtimePublisher.publishNow(
            caseId,
            EquipoResolutoresRealtimePublisher.TYPE_CUSTODY,
            null
        );
    }

    public class PlantillaItem {
        @AuraEnabled public String name;
        @AuraEnabled public String label;
        @AuraEnabled public String texto;
        @AuraEnabled public String categoria;
        @AuraEnabled public Decimal orden;
    }

    /** Plantillas de comentario activas filtradas por tipo de ticket del Case. */
    @AuraEnabled(cacheable=true)
    public static List<PlantillaItem> getPlantillasForCase(Id caseId) {
        List<PlantillaItem> result = new List<PlantillaItem>();

        if (!Schema.getGlobalDescribe().containsKey('Plantilla_Comentario_SLA__mdt')) {
            return result;
        }

        String tipoTicket = 'Ambos';
        if (caseId != null) {
            List<Case> casos = [
                SELECT RecordType.DeveloperName FROM Case WHERE Id = :caseId LIMIT 1
            ];
            if (!casos.isEmpty() && casos[0].RecordType != null
                && casos[0].RecordType.DeveloperName != null) {
                String dn = casos[0].RecordType.DeveloperName;
                if (dn == 'Incidente' || dn == 'Requerimiento') {
                    tipoTicket = dn;
                }
            }
        }

        String soql =
            'SELECT DeveloperName, MasterLabel, Texto__c, Categoria__c, Orden__c, Tipo_Ticket__c '
            + 'FROM Plantilla_Comentario_SLA__mdt '
            + 'WHERE Activo__c = true '
            + 'AND (Tipo_Ticket__c = \'Ambos\' OR Tipo_Ticket__c = :tipoTicket) '
            + 'ORDER BY Orden__c ASC NULLS LAST, MasterLabel ASC';

        try {
            for (SObject p : Database.query(soql)) {
                PlantillaItem it = new PlantillaItem();
                it.name = (String) p.get('DeveloperName');
                it.label = (String) p.get('MasterLabel');
                it.texto = (String) p.get('Texto__c');
                it.categoria = (String) p.get('Categoria__c');
                it.orden = (Decimal) p.get('Orden__c');
                result.add(it);
            }
        } catch (Exception e) {
            System.debug(LoggingLevel.WARN, 'No se pudieron cargar plantillas: ' + e.getMessage());
        }

        return result;
    }

    /** Inserta un CaseComment público (visible para el cliente). */
    @AuraEnabled
    public static Id addPublicCaseComment(Id caseId, String texto) {
        if (caseId == null) {
            throw new AuraHandledException('Caso no valido.');
        }
        assertCaseOpen(caseId);
        if (String.isBlank(texto)) {
            throw new AuraHandledException('El comentario no puede estar vacio.');
        }
        CaseComment c = new CaseComment(
            ParentId = caseId,
            CommentBody = texto,
            IsPublished = true
        );
        try {
            insert c;
        } catch (DmlException e) {
            throw new AuraHandledException(parseDmlMessage(e));
        }
        return c.Id;
    }

    /** Tickets donde el usuario es apoyo o tiene custodia (no solo resolutor owner). */
    @AuraEnabled
    public static List<SlaMonitorRow> getMisApoyosForCurrentUser() {
        List<SlaMonitorRow> rows = new List<SlaMonitorRow>();
        for (SlaMonitorRow row : getSlaMonitorForCurrentUser()) {
            if (row.myRole == 'Apoyo' || row.myRole == 'Responsable') {
                rows.add(row);
            }
        }
        return rows;
    }

    private static void syncCaseCustodian(Id caseId, Id custodianUserId) {
        if (caseId == null) {
            return;
        }
        if (!Case.SObjectType.getDescribe().fields.getMap().containsKey(FIELD_CUSTODIO_CASE)) {
            return;
        }
        try {
            SObject caso = Case.SObjectType.newSObject(caseId);
            caso.put(FIELD_CUSTODIO_CASE, custodianUserId);
            update caso;
        } catch (DmlException e) {
            System.debug(LoggingLevel.WARN, 'No se pudo actualizar Custodio_Actual__c: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static void updateMember(Id recordId, String role, String notes) {
        if (recordId == null) {
            throw new AuraHandledException('Registro no válido.');
        }
        if (String.isBlank(role)) {
            throw new AuraHandledException('Seleccioná la especialidad.');
        }

        Equipo_de_Resolutores__c rec = [
            SELECT Id, Inicio__c, Fin__c, Ticket__c
            FROM Equipo_de_Resolutores__c
            WHERE Id = :recordId
            LIMIT 1
        ];
        assertCaseOpen(rec.Ticket__c);

        Case caso = [
            SELECT Status FROM Case WHERE Id = :rec.Ticket__c LIMIT 1
        ];
        populateEquipoContext(rec, caso, role);
        rec.Notas__c = notes;

        try {
            update rec;
        } catch (DmlException e) {
            throw new AuraHandledException(parseDmlMessage(e));
        }
        EquipoResolutoresRealtimePublisher.publishNow(
            rec.Ticket__c,
            EquipoResolutoresRealtimePublisher.TYPE_TEAM,
            null
        );
    }

    @AuraEnabled
    public static void deleteMember(Id caseId, Id userId) {
        if (caseId == null || userId == null) {
            throw new AuraHandledException('Datos no válidos.');
        }
        assertCaseOpen(caseId);

        Id ownerId = resolveCaseOwnerUserId(caseId);
        if (userId == ownerId) {
            throw new AuraHandledException('No se puede quitar al resolutor del ticket.');
        }

        List<Equipo_de_Resolutores__c> custodiaAbierta = [
            SELECT Id FROM Equipo_de_Resolutores__c
            WHERE Ticket__c = :caseId
              AND Resolutor__c = :userId
              AND Inicio__c != null
              AND Fin__c = null
            LIMIT 1
        ];
        if (!custodiaAbierta.isEmpty()) {
            transferCustody(caseId, ownerId, null);
        }

        List<Equipo_de_Resolutores__c> apoyos = [
            SELECT Id, Notas__c FROM Equipo_de_Resolutores__c
            WHERE Ticket__c = :caseId
              AND Resolutor__c = :userId
              AND Inicio__c = null
              AND Fin__c = null
        ];
        if (apoyos.isEmpty()) {
            throw new AuraHandledException(
                'No se puede eliminar: solo queda historial de responsable en este ticket.'
            );
        }

        Case caso = [SELECT Status FROM Case WHERE Id = :caseId LIMIT 1];
        Datetime nowDt = System.now();
        for (Equipo_de_Resolutores__c ap : apoyos) {
            ap.Fin__c = nowDt;
            ap.Notas__c = NOTA_ELIMINADO_EQUIPO;
            populateEquipoContext(ap, caso, null);
        }

        try {
            update apoyos;
            ensureCustodyToOwner(caseId);
        } catch (DmlException e) {
            throw new AuraHandledException(parseDmlMessage(e));
        }
        EquipoResolutoresRealtimePublisher.publishNow(
            caseId,
            EquipoResolutoresRealtimePublisher.TYPE_TEAM,
            null
        );
    }

    /**
     * Garantiza que el ticket tenga un tramo de custodia abierto en el resolutor
     * (owner del Case). Nunca debe quedar sin responsable activo.
     */
    private static void ensureCustodyToOwner(Id caseId) {
        List<Equipo_de_Resolutores__c> abiertos = [
            SELECT Id FROM Equipo_de_Resolutores__c
            WHERE Ticket__c = :caseId AND Inicio__c != null AND Fin__c = null
            LIMIT 1
        ];
        if (!abiertos.isEmpty()) {
            return;
        }

        Case c = [
            SELECT OwnerId, Status, IsStopped
            FROM Case
            WHERE Id = :caseId
            LIMIT 1
        ];
        Id ownerId = c.OwnerId;
        if (ownerId == null || !String.valueOf(ownerId).startsWith('005')) {
            return;
        }

        Datetime nowDt = System.now();
        Equipo_de_Resolutores__c reg = new Equipo_de_Resolutores__c(
            Ticket__c = caseId,
            Resolutor__c = ownerId,
            Inicio__c = nowDt
        );
        populateEquipoContext(reg, c, null);
        if (c.IsStopped == true) {
            reg.Pausa_Inicio__c = nowDt;
        }
        reg.RecordTypeId = getMatchingRecordTypeId(caseId);
        try {
            insert reg;
            syncCaseCustodian(caseId, ownerId);
        } catch (DmlException e) {
            throw new AuraHandledException(parseDmlMessage(e));
        }
    }

    private static Id resolveCaseOwnerUserId(Id caseId) {
        Case c = [SELECT OwnerId FROM Case WHERE Id = :caseId LIMIT 1];
        Id ownerId = c.OwnerId;
        if (ownerId == null || !String.valueOf(ownerId).startsWith('005')) {
            throw new AuraHandledException(
                'No hay resolutor de ticket asignado para asumir la responsabilidad.'
            );
        }
        return ownerId;
    }

    private static Id getMatchingRecordTypeId(Id caseId) {
        Case c = [SELECT RecordType.DeveloperName FROM Case WHERE Id = :caseId LIMIT 1];
        if (c.RecordType == null || c.RecordType.DeveloperName == null) return null;
        List<RecordType> rts = [
            SELECT Id FROM RecordType
            WHERE SobjectType = 'Equipo_de_Resolutores__c'
              AND DeveloperName = :c.RecordType.DeveloperName
            LIMIT 1
        ];
        return rts.isEmpty() ? null : rts[0].Id;
    }
}