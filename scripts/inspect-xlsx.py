"""Read-only, independent OpenXML/ZIP export validator (Python standard library)."""
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None
    names = archive.namelist()
    assert '[Content_Types].xml' in names and '_rels/.rels' in names
    workbook = ET.fromstring(archive.read('xl/workbook.xml'))
    results = []
    for index, sheet in enumerate(workbook.findall('s:sheets/s:sheet', ns), start=1):
        root = ET.fromstring(archive.read(f'xl/worksheets/sheet{index}.xml'))
        rows = []
        for row in root.findall('s:sheetData/s:row', ns):
            values = []
            for cell in row.findall('s:c', ns):
                assert cell.find('s:f', ns) is None, 'Unexpected formula in business snapshot'
                value = ''.join(cell.itertext()) if cell.get('t') == 'inlineStr' else cell.findtext('s:v', default='', namespaces=ns)
                values.append({'address': cell.get('r'), 'type': cell.get('t', 'n'), 'value': value})
            rows.append(values)
        results.append({'name': sheet.get('name'), 'rows': rows, 'frozen': root.find('s:sheetViews/s:sheetView/s:pane', ns).get('topLeftCell'), 'filter': root.find('s:autoFilter', ns).get('ref')})
    assert not any('media/' in name or 'externalLink' in name for name in names)
    print(json.dumps({'sheets': results}, ensure_ascii=False))
