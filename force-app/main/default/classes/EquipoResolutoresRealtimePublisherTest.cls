@IsTest
private class EquipoResolutoresRealtimePublisherTest {

    @IsTest
    static void publishNow_completes_without_error() {
        Case c = new Case(Subject = 'Realtime test', Status = 'New');
        insert c;

        EquipoResolutoresRealtimePublisher.clearPendingForTest();

        Test.startTest();
        EquipoResolutoresRealtimePublisher.publishNow(
            c.Id,
            EquipoResolutoresRealtimePublisher.TYPE_TEAM,
            null
        );
        Test.stopTest();

        System.assertEquals(
            0,
            EquipoResolutoresRealtimePublisher.pendingCountForTest(),
            'La cola debe quedar vacía tras publishNow'
        );
    }

    @IsTest
    static void flushPending_clears_queue() {
        Case c = new Case(Subject = 'Flush test', Status = 'New');
        insert c;

        EquipoResolutoresRealtimePublisher.clearPendingForTest();
        EquipoResolutoresRealtimePublisher.requestPublish(
            c.Id,
            EquipoResolutoresRealtimePublisher.TYPE_SLA,
            null
        );

        Test.startTest();
        EquipoResolutoresRealtimePublisher.flushPending();
        Test.stopTest();

        System.assertEquals(
            0,
            EquipoResolutoresRealtimePublisher.pendingCountForTest(),
            'flushPending debe vaciar la cola'
        );
    }

    @IsTest
    static void mergeChangeType_caseClosed_wins_over_sla() {
        String merged = EquipoResolutoresRealtimePublisher.mergeChangeTypeForTest(
            EquipoResolutoresRealtimePublisher.TYPE_SLA,
            EquipoResolutoresRealtimePublisher.TYPE_CASE_CLOSED
        );
        System.assertEquals(
            EquipoResolutoresRealtimePublisher.TYPE_CASE_CLOSED,
            merged,
            'CASE_CLOSED debe ganar prioridad sobre SLA'
        );
    }

    @IsTest
    static void resolveStakeholders_includes_case_owner() {
        User u = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId() LIMIT 1];
        Case c = new Case(Subject = 'Stakeholders', Status = 'New', OwnerId = u.Id);
        insert c;

        Set<Id> stakeholders = EquipoResolutoresRealtimePublisher.resolveStakeholders(c.Id);
        System.assert(stakeholders.contains(u.Id), 'Debe incluir al owner del Case');
    }

    @IsTest
    static void requestPublish_null_caseId_is_ignored() {
        EquipoResolutoresRealtimePublisher.clearPendingForTest();
        EquipoResolutoresRealtimePublisher.requestPublish(
            null,
            EquipoResolutoresRealtimePublisher.TYPE_TEAM,
            null
        );
        System.assertEquals(
            0,
            EquipoResolutoresRealtimePublisher.pendingCountForTest(),
            'No debe encolar sin Case Id'
        );
    }
}
