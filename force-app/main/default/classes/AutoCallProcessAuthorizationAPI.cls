@RestResource(urlMapping='/GoogleSheetSync/*')
global with sharing class AutoCallProcessAuthorizationAPI {

    @HttpPost
    global static void receiveUpdate() {
        RestRequest req = RestContext.request;
        String body = req.requestBody.toString();
        Map<String, Object> jsonObj = (Map<String, Object>) JSON.deserializeUntyped(body);
System.debug(jsonObj);
System.debug(jsonObj.get('base64'));
        Object jo = jsonObj.get('base64').toString();
         Object recordCount = jsonObj.get('noOfRows').toString();    
        String base64String = String.valueOf(jo);
String jsonString = EncodingUtil.base64Decode(base64String).toString();
System.debug('Decoded JSON: ' + jsonString);

        //System.debug('Received JSON from Google Sheet: ' + body);
        
        Id contentVesionID = ProcessActualizationDataController.uploadNewFileVersion(body, 'APAC');
        System.debug('contentVesionID: ' + contentVesionID);
        File_Uploaded_Event__e evt = new File_Uploaded_Event__e();
        evt.ContentVersionId__c = contentVesionID;
        evt.RecordCount__c = Integer.valueOf(recordCount);
        //evt.FileData__c = jsonString;

        List<Object> parsed =
        (List<Object>) JSON.deserializeUntyped(jsonString);

        List<Map<String, Object>> cleaned = new List<Map<String, Object>>();

        for (Object o : parsed) {
            Map<String, Object> row = (Map<String, Object>) o;
            Map<String, Object> cleanRow = new Map<String, Object>();
            if (!row.isEmpty()) {
                cleanRow.put('SellLine', row.values()[0]);
            } else {
                cleanRow.put('SellLine', '');
            }

            cleanRow.putAll(row);
            cleaned.add(cleanRow);
        }

        evt.FileData__c = JSON.serialize(cleaned);


        EventBus.publish(evt);
         System.debug('evt: ' + evt);
    }
}