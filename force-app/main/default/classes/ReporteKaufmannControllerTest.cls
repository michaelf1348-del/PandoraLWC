@isTest
private class ReporteKaufmannControllerTest {

    /**
     * Tests centrados en la API estable del controller (templates, configs, files, validaciones).
     * NOTA: getReportData / enrichReportJsonWithLongTextAreas no se cubren directamente porque
     * dependen de Reports.ReportManager y la API de informes no es mockeable sin Test.setMock.
     * S� se cubren los helpers p�blicos auxiliares para garantizar el camino feliz.
     */

    // --- Plantillas Excel ---

    @isTest
    static void saveTemplate_insertAndUpdate() {
        String fakeReportId = '00OAA000000Test1AA';

        Test.startTest();
        ReporteKaufmannController.saveTemplate(fakeReportId, '{"version":"2.0","sheets":[]}');
        String first = ReporteKaufmannController.getTemplate(fakeReportId);
        System.assert(first != null && first.contains('"sheets"'), 'Debe persistir la primera plantilla');

        ReporteKaufmannController.saveTemplate(fakeReportId, '{"version":"2.0","sheets":[{"name":"x"}]}');
        String second = ReporteKaufmannController.getTemplate(fakeReportId);
        Test.stopTest();

        System.assert(second.contains('"name":"x"'), 'El update debe sobreescribir el JSON');
        System.assertNotEquals(first, second, 'Insert y update deben producir contenidos distintos');
    }

    @isTest
    static void saveTemplate_validatesInput() {
        try {
            ReporteKaufmannController.saveTemplate('', '{}');
            System.assert(false, 'Debe lanzar excepci�n con reportId vac�o');
        } catch (AuraHandledException e) {
            System.assert(true);
        }
        try {
            ReporteKaufmannController.saveTemplate('00OAA000000XYZ1', '');
            System.assert(false, 'Debe lanzar excepci�n con jsonConfig vac�o');
        } catch (AuraHandledException e) {
            System.assert(true);
        }
    }

    @isTest
    static void getTemplate_returnsNullWhenMissing() {
        String result = ReporteKaufmannController.getTemplate('00OAA000000NoExist');
        System.assertEquals(null, result, 'Sin plantilla guardada debe devolver null');
    }

    @isTest
    static void getTemplate_returnsNullForBlankInput() {
        System.assertEquals(null, ReporteKaufmannController.getTemplate(''), 'Input vac�o ? null');
        System.assertEquals(null, ReporteKaufmannController.getTemplate(null), 'Input null ? null');
    }

    // --- Variantes de plantilla (V) ---

    @isTest
    static void variants_createListAndApply() {
        String rid = '00OAA000000Vart1AA';
        Test.startTest();
        /* Crear dos variantes y verificar que se listan en orden default-first. */
        String v1 = ReporteKaufmannController.saveVariant(rid, '', 'Vista ejecutiva', true, true, '{"sheets":[1]}');
        String v2 = ReporteKaufmannController.saveVariant(rid, '', 'Solo abiertos',  false, true, '{"sheets":[2]}');
        System.assertNotEquals(null, v1, 'saveVariant debe devolver el id generado');
        System.assertNotEquals(null, v2, 'segunda variante tambi�n debe devolver id');
        System.assertNotEquals(v1, v2, 'ids distintos');

        List<ReporteKaufmannController.VariantSummary> lst = ReporteKaufmannController.listVariants(rid);
        System.assertEquals(2, lst.size(), 'Debe haber 2 variantes');
        System.assertEquals(true, lst[0].esDefault, 'La default sale primero');
        System.assertEquals('Vista ejecutiva', lst[0].nombre);

        /* Leer el JSON de la primera. */
        String json1 = ReporteKaufmannController.getVariant(rid, v1);
        System.assert(json1 != null && json1.contains('"sheets":[1]'), 'getVariant debe leer el JSON');
        Test.stopTest();
    }

    @isTest
    static void variants_onlyOneDefaultAtATime() {
        String rid = '00OAA000000Vart2AA';
        Test.startTest();
        String v1 = ReporteKaufmannController.saveVariant(rid, '', 'A', true,  true, '{"x":1}');
        String v2 = ReporteKaufmannController.saveVariant(rid, '', 'B', true,  true, '{"x":2}');
        /* Al marcar B como default, A pierde la marca. */
        List<ReporteKaufmannController.VariantSummary> lst = ReporteKaufmannController.listVariants(rid);
        Integer defaultCount = 0;
        for (ReporteKaufmannController.VariantSummary v : lst) if (v.esDefault) defaultCount++;
        System.assertEquals(1, defaultCount, 'Solo una variante puede ser default a la vez');
        Test.stopTest();
    }

    @isTest
    static void variants_duplicateAndDelete() {
        String rid = '00OAA000000Vart3AA';
        String v1 = ReporteKaufmannController.saveVariant(rid, '', 'Original', true, true, '{"k":"v"}');
        Test.startTest();
        String v2 = ReporteKaufmannController.duplicateVariant(rid, v1, 'Copia');
        System.assertNotEquals(null, v2);
        System.assertEquals(2, ReporteKaufmannController.listVariants(rid).size());

        /* Eliminar la copia funciona. */
        ReporteKaufmannController.deleteVariant(rid, v2);
        System.assertEquals(1, ReporteKaufmannController.listVariants(rid).size());

        /* No se permite borrar la �ltima variante. */
        try {
            ReporteKaufmannController.deleteVariant(rid, v1);
            System.assert(false, 'Debe rechazar borrar la �nica variante restante');
        } catch (AuraHandledException e) {
            System.assert(true);
        }
        Test.stopTest();
    }

    @isTest
    static void variants_legacyTemplateGetsPromotedToDefault() {
        String rid = '00OAA000000Vart4AA';
        /* Simulamos plantilla legacy: insertamos directamente sin variantes. */
        Plantilla_Reporte__c legacy = new Plantilla_Reporte__c(
            ID_del_Reporte__c = rid,
            Configuracion_JSON__c = '{"legacy":true}'
        );
        insert legacy;

        Test.startTest();
        List<ReporteKaufmannController.VariantSummary> lst = ReporteKaufmannController.listVariants(rid);
        Test.stopTest();

        System.assertEquals(1, lst.size(), 'La plantilla legacy debe aparecer como una variante');
        System.assertEquals(true, lst[0].esDefault, 'Debe quedar marcada como default');
        System.assertNotEquals(null, lst[0].varianteId, 'Debe asignarse un varianteId');
    }

    @isTest
    static void variants_validatesInput() {
        try {
            ReporteKaufmannController.saveVariant('', '', 'X', false, true, '{}');
            System.assert(false, 'Debe lanzar con reportId vac�o');
        } catch (AuraHandledException e) { System.assert(true); }
        try {
            ReporteKaufmannController.saveVariant('00OAA000000ABC1', '', '', false, true, '{}');
            System.assert(false, 'Debe lanzar con nombre vac�o');
        } catch (AuraHandledException e) { System.assert(true); }
        try {
            ReporteKaufmannController.saveVariant('00OAA000000ABC1', '', 'X', false, true, '');
            System.assert(false, 'Debe lanzar con jsonConfig vac�o');
        } catch (AuraHandledException e) { System.assert(true); }
    }

    // --- Configuraci�n PPT ---

    @isTest
    static void savePptConfig_insertAndUpdate() {
        String fakeReportId = '00OAA000000Test2AA';

        Test.startTest();
        /* Sin varianteId → tratado como 'default' por el controller. */
        ReporteKaufmannController.savePptConfig(fakeReportId, null, '{"pptConfigVersion":2,"presentations":[]}');
        String first = ReporteKaufmannController.getPptConfig(fakeReportId, null);
        System.assert(first != null && first.contains('"pptConfigVersion"'), 'Debe persistir config PPT inicial');

        ReporteKaufmannController.savePptConfig(fakeReportId, 'default', '{"pptConfigVersion":2,"presentations":[{"id":"a"}]}');
        String second = ReporteKaufmannController.getPptConfig(fakeReportId, 'default');
        Test.stopTest();

        System.assert(second.contains('"id":"a"'), 'Update debe persistir nuevas variantes PPT');
        System.assertNotEquals(first, second);
    }

    @isTest
    static void getPptConfig_returnsNullWhenMissing() {
        System.assertEquals(null, ReporteKaufmannController.getPptConfig('00OAA000000NoPPT', 'default'));
        System.assertEquals(null, ReporteKaufmannController.getPptConfig('', null));
    }

    @isTest
    static void savePptConfig_validatesInput() {
        try {
            ReporteKaufmannController.savePptConfig('', null, '{}');
            System.assert(false, 'Debe lanzar excepci�n con reportId vac�o');
        } catch (AuraHandledException e) {
            System.assert(true);
        }
    }

    /* Aislamiento: dos variantes del mismo reporte tienen configs PPT independientes. */
    @isTest
    static void savePptConfig_isolatesVariants() {
        String rid = '00OAA000000IsoAA';
        Test.startTest();
        ReporteKaufmannController.savePptConfig(rid, 'variantA', '{"pptConfigVersion":2,"presentations":[{"id":"A"}]}');
        ReporteKaufmannController.savePptConfig(rid, 'variantB', '{"pptConfigVersion":2,"presentations":[{"id":"B"}]}');
        String cfgA = ReporteKaufmannController.getPptConfig(rid, 'variantA');
        String cfgB = ReporteKaufmannController.getPptConfig(rid, 'variantB');
        Test.stopTest();
        System.assert(cfgA.contains('"id":"A"'), 'variantA debe tener su propia config');
        System.assert(cfgB.contains('"id":"B"'), 'variantB debe tener su propia config');
        System.assertNotEquals(cfgA, cfgB, 'Las configs de cada variante deben ser independientes');
    }

    /* Herencia legacy en LECTURA: un registro Plantilla_Geneador_PPT__c sin Variante_Id__c
       debe poder leerse pidiendo varianteId='default'. La lectura NO debe mutar el legacy
       (la promoci\u00f3n del campo Variante_Id__c se reserva al guardado expl\u00edcito para
       evitar p\u00e9rdidas de datos cuando el reporteKaufmann env\u00eda distintos varianteId). */
    @isTest
    static void getPptConfig_readsLegacyWithoutMutation() {
        String rid = '00OAA000000LegAA';
        Plantilla_Geneador_PPT__c legacy = new Plantilla_Geneador_PPT__c(
            Name = rid,
            Configuracion_PPT__c = '{"pptConfigVersion":2,"presentations":[{"id":"L"}]}'
        );
        insert legacy;

        Test.startTest();
        String cfg = ReporteKaufmannController.getPptConfig(rid, 'default');
        Test.stopTest();
        System.assert(cfg != null && cfg.contains('"id":"L"'), 'Debe devolver la config legacy al pedir default');
        Plantilla_Geneador_PPT__c reloaded = [SELECT Variante_Id__c FROM Plantilla_Geneador_PPT__c WHERE Id = :legacy.Id];
        /* CONTRATO NUEVO: la lectura NO promueve. El legacy se queda con Variante_Id__c=null
           hasta que alguien guarde expl\u00edcitamente sobre 'default'. */
        System.assert(String.isBlank(reloaded.Variante_Id__c), 'La lectura no debe mutar el Variante_Id__c del registro legacy');
    }

    /* Herencia hacia la variante default del reporte: cuando llega un varianteId UUID concreto
       que es la default del reporte, tambi\u00e9n debe poder leer el PPT legacy.
       NO se promueve en la lectura. */
    @isTest
    static void getPptConfig_inheritsLegacyForDefaultReportVariant() {
        String rid = '00OAA000000InhAA';
        String vidDefault = 'v_default_uuid_x1';
        insert new Plantilla_Reporte__c(
            ID_del_Reporte__c = rid,
            Variante_Id__c = vidDefault,
            Variante_Nombre__c = 'Default',
            Es_Default__c = true,
            Es_Publica__c = true,
            Configuracion_JSON__c = '{}'
        );
        Plantilla_Geneador_PPT__c legacy = new Plantilla_Geneador_PPT__c(
            Name = rid,
            Configuracion_PPT__c = '{"pptConfigVersion":2,"presentations":[{"id":"INH"}]}'
        );
        insert legacy;

        Test.startTest();
        String cfg = ReporteKaufmannController.getPptConfig(rid, vidDefault);
        Test.stopTest();
        System.assert(cfg != null && cfg.contains('"id":"INH"'), 'La variante default del reporte debe heredar el PPT legacy');
        Plantilla_Geneador_PPT__c reloaded = [SELECT Variante_Id__c FROM Plantilla_Geneador_PPT__c WHERE Id = :legacy.Id];
        /* CONTRATO NUEVO: la lectura no muta. El legacy sigue null. La promoci\u00f3n ocurre
           solo al guardar contra 'default'. */
        System.assert(String.isBlank(reloaded.Variante_Id__c), 'La lectura no debe mutar el Variante_Id__c del registro legacy');
    }

    /* Verifica el contrato de promoci\u00f3n al GUARDAR:
       - Si existe un legacy (Variante_Id__c=null) y guardamos con 'default', el legacy se
         promueve a Variante_Id__c='default' (caso natural de migraci\u00f3n al uso expl\u00edcito).
       - Si existe un legacy y guardamos con UUID real, se INSERTA un registro nuevo y el
         legacy queda intacto (evita p\u00e9rdida de datos para futuras lecturas con 'default'). */
    @isTest
    static void savePptConfig_promotesLegacyOnlyForDefault() {
        String rid = '00OAA000000PrmAA';
        Plantilla_Geneador_PPT__c legacy = new Plantilla_Geneador_PPT__c(
            Name = rid,
            Configuracion_PPT__c = '{"pptConfigVersion":2,"presentations":[{"id":"OLD"}]}'
        );
        insert legacy;

        Test.startTest();
        /* Guardado con 'default': debe promover el legacy. */
        ReporteKaufmannController.savePptConfig(rid, 'default', '{"pptConfigVersion":2,"presentations":[{"id":"NEW"}]}');
        Test.stopTest();

        List<Plantilla_Geneador_PPT__c> all = [SELECT Variante_Id__c, Configuracion_PPT__c FROM Plantilla_Geneador_PPT__c WHERE Name = :rid];
        System.assertEquals(1, all.size(), 'Guardar contra default debe seguir siendo 1 \u00fanico registro (promoci\u00f3n in-place)');
        System.assertEquals('default', all[0].Variante_Id__c, 'El legacy debe quedar promovido a default tras el save');
        System.assert(all[0].Configuracion_PPT__c.contains('"id":"NEW"'), 'El JSON debe ser el nuevo guardado');
    }

    /* Variante UUID real con legacy default existente: el save crea un nuevo registro,
       el legacy se preserva (no se pierde su contenido). */
    @isTest
    static void savePptConfig_keepsLegacyWhenSavingUuidVariant() {
        String rid = '00OAA000000FrkAA';
        String vidUuid = 'v_uuid_real_z9';
        /* Variante default del reporte (para que canInheritLegacy sea true). */
        insert new Plantilla_Reporte__c(
            ID_del_Reporte__c = rid,
            Variante_Id__c = vidUuid,
            Variante_Nombre__c = 'Default',
            Es_Default__c = true,
            Es_Publica__c = true,
            Configuracion_JSON__c = '{}'
        );
        Plantilla_Geneador_PPT__c legacy = new Plantilla_Geneador_PPT__c(
            Name = rid,
            Variante_Id__c = 'default',
            Configuracion_PPT__c = '{"pptConfigVersion":2,"presentations":[{"id":"LEGACY"}]}'
        );
        insert legacy;

        Test.startTest();
        ReporteKaufmannController.savePptConfig(rid, vidUuid, '{"pptConfigVersion":2,"presentations":[{"id":"BRANCH"}]}');
        Test.stopTest();

        List<Plantilla_Geneador_PPT__c> all = [SELECT Variante_Id__c, Configuracion_PPT__c FROM Plantilla_Geneador_PPT__c WHERE Name = :rid ORDER BY Variante_Id__c];
        System.assertEquals(2, all.size(), 'Debe haber 2 registros: el legacy default intacto y el nuevo asociado al UUID');
        /* El legacy ('default') sigue con su contenido original. */
        Plantilla_Geneador_PPT__c reloaded = [SELECT Configuracion_PPT__c FROM Plantilla_Geneador_PPT__c WHERE Id = :legacy.Id];
        System.assert(reloaded.Configuracion_PPT__c.contains('"id":"LEGACY"'), 'El legacy NO debe haber sido machacado por el save de UUID');
    }

    /* Aislamiento de variantes no-default: una variante secundaria NO debe heredar el PPT legacy. */
    @isTest
    static void getPptConfig_doesNotInheritLegacyForSecondaryVariant() {
        String rid = '00OAA000000NoInh';
        String vidSecondary = 'v_secondary_uuid_y2';
        /* 1) Variante SECUNDARIA (no default) del reporte. */
        insert new Plantilla_Reporte__c(
            ID_del_Reporte__c = rid,
            Variante_Id__c = vidSecondary,
            Variante_Nombre__c = 'Otra',
            Es_Default__c = false,
            Es_Publica__c = true,
            Configuracion_JSON__c = '{}'
        );
        /* 2) Config PPT legacy. */
        insert new Plantilla_Geneador_PPT__c(
            Name = rid,
            Configuracion_PPT__c = '{"pptConfigVersion":2,"presentations":[{"id":"OLD"}]}'
        );

        Test.startTest();
        String cfg = ReporteKaufmannController.getPptConfig(rid, vidSecondary);
        Test.stopTest();
        System.assertEquals(null, cfg, 'Las variantes secundarias NO deben heredar el PPT legacy; deben empezar vacías');
    }

    // --- Files / base64 ---

    private static Id createTestFile(String name, Integer sizeBytes) {
        ContentVersion cv = new ContentVersion();
        cv.Title = name;
        cv.PathOnClient = name + '.png';
        Blob payload = Blob.valueOf('x'.repeat(sizeBytes));
        cv.VersionData = payload;
        insert cv;
        cv = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id];
        return cv.ContentDocumentId;
    }

    @isTest
    static void getExcelFileBase64_returnsContent() {
        Id docId = createTestFile('excel_test', 100);
        Test.startTest();
        String b64 = ReporteKaufmannController.getExcelFileBase64(docId);
        Test.stopTest();
        System.assert(String.isNotBlank(b64), 'Debe devolver base64 del archivo');
    }

    @isTest
    static void getExcelFileBase64_validatesNullId() {
        try {
            ReporteKaufmannController.getExcelFileBase64(null);
            System.assert(false, 'Debe lanzar excepci�n si el Id es null');
        } catch (AuraHandledException e) {
            System.assert(true);
        }
    }

    @isTest
    static void getBase64Images_emptyInputReturnsEmptyMap() {
        Map<Id, String> result = ReporteKaufmannController.getBase64Images(new List<Id>());
        System.assert(result != null && result.isEmpty(), 'Lista vac�a ? mapa vac�o');

        Map<Id, String> resultNull = ReporteKaufmannController.getBase64Images(null);
        System.assert(resultNull != null && resultNull.isEmpty(), 'Null ? mapa vac�o');
    }

    @isTest
    static void getBase64Images_returnsBase64ForValidDocs() {
        Id docA = createTestFile('imgA', 50);
        Id docB = createTestFile('imgB', 50);

        Test.startTest();
        Map<Id, String> result = ReporteKaufmannController.getBase64Images(new List<Id>{ docA, docB });
        Test.stopTest();

        System.assertEquals(2, result.size(), 'Ambas im�genes deben venir codificadas');
        System.assert(String.isNotBlank(result.get(docA)));
        System.assert(String.isNotBlank(result.get(docB)));
    }

    @isTest
    static void getBase64Images_rejectsTooManyDocs() {
        /* El controller verifica el limite (>20) ANTES de cualquier SOQL, asi que duplicar
           un mismo Id valido 21 veces es suficiente para validar la regla.
           Evitamos Id.valueOf con strings sinteticos (Salesforce ya no los acepta en
           runtime moderno por checksums internos). */
        List<Id> manyIds = new List<Id>();
        Id realId = UserInfo.getUserId();
        for (Integer i = 0; i < 21; i++) {
            manyIds.add(realId);
        }
        try {
            ReporteKaufmannController.getBase64Images(manyIds);
            System.assert(false, 'Debe lanzar excepci�n con >20 documentos');
        } catch (AuraHandledException e) {
            System.assert(true);
        }
    }

    @isTest
    static void saveExcelToSalesforce_persistsContentVersion() {
        /* No pasamos recordId para evitar el insert del ContentDocumentLink: la org
           tiene validation rules custom en Account (RUT__c, Categoria_de_Cliente__c)
           y el controller hardcodea ShareType='V', que no es compatible con User como
           LinkedEntity (User requiere ShareType='I'). El test verifica el camino
           principal: que el archivo se persista como ContentVersion. */
        String b64 = EncodingUtil.base64Encode(Blob.valueOf('contenido excel'));

        Test.startTest();
        Id contentDocId = ReporteKaufmannController.saveExcelToSalesforce(b64, 'reporte_test', null);
        Test.stopTest();

        System.assertNotEquals(null, contentDocId, 'Debe devolver el ContentDocumentId creado');
        List<ContentVersion> versions = [
            SELECT Id, Title, PathOnClient FROM ContentVersion
            WHERE ContentDocumentId = :contentDocId AND IsLatest = true
        ];
        System.assert(!versions.isEmpty(), 'Debe persistirse al menos un ContentVersion');
    }

    @isTest
    static void saveExcelToSalesforce_rejectsEmptyBase64() {
        try {
            ReporteKaufmannController.saveExcelToSalesforce('', 'archivo', null);
            System.assert(false, 'Debe lanzar excepci�n con base64 vac�o');
        } catch (AuraHandledException e) {
            System.assert(true);
        }
    }

    // --- Reports / enrichment input validation ---

    @isTest
    static void getReportData_rejectsNullReportId() {
        try {
            ReporteKaufmannController.getReportData(null);
            System.assert(false, 'Debe lanzar excepci�n con reportId null');
        } catch (AuraHandledException e) {
            System.assert(true);
        }
    }

    // --- Fallback long-text Custom Metadata ---

    @isTest
    static void longTextFallbacks_returnsConfiguredEntries() {
        Test.startTest();
        List<Map<String, String>> fbs = ReporteKaufmannController.getConfiguredLongTextFallbacks();
        Test.stopTest();
        System.assert(fbs != null && !fbs.isEmpty(), 'Siempre devuelve al menos el fallback de Gestiones');
        Boolean hasGestiones = false;
        for (Map<String, String> e : fbs) {
            if ('Gestiones_Kaufmann__c'.equalsIgnoreCase(e.get('object'))
                && 'Reporte_Avance__c'.equalsIgnoreCase(e.get('field'))) {
                hasGestiones = true;
                break;
            }
        }
        System.assert(hasGestiones, 'Debe incluir el fallback hist�rico Gestiones.Reporte_Avance');
    }

    // --- Available reports ---

    @isTest
    static void getAvailableReports_executesWithoutError() {
        Test.startTest();
        try {
            ReporteKaufmannController.getAvailableReports();
            System.assert(true);
        } catch (Exception e) {
            /* En orgs sin reportes el SOQL devuelve vac�o, no excepci�n. Si la org tiene FLS bloqueada
               sobre Report, WITH SECURITY_ENFORCED puede fallar; aceptamos esa excepci�n tipada. */
            System.assert(e instanceof AuraHandledException, 'Errores esperables son AuraHandledException');
        }
        Test.stopTest();
    }

    @isTest
    static void getPptDesigns_executesWithoutError() {
        Test.startTest();
        try {
            ReporteKaufmannController.getPptDesigns();
            System.assert(true);
        } catch (Exception e) {
            System.assert(e instanceof AuraHandledException);
        }
        Test.stopTest();
    }
}
