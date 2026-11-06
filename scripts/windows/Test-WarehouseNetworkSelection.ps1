$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Select-WarehouseNetwork.ps1')
function Candidate($index,$ip,$state='Preferred',$skip=$false){
 [pscustomobject]@{InterfaceIndex=$index;IPAddress=$ip;AddressState=$state;SkipAsSource=$skip}
}
function Route($index,$routeMetric,$interfaceMetric){
 [pscustomobject]@{InterfaceIndex=$index;RouteMetric=$routeMetric;InterfaceMetric=$interfaceMetric}
}
function AssertRejected([scriptblock]$action,[string]$pattern){
 try{& $action;throw 'Expected selection to fail.'}
 catch{if($_.Exception.Message -notmatch $pattern){throw}}
}
$wifi=Candidate 7 '192.168.0.97'
$ethernet=Candidate 8 '192.168.2.20'
$invalid=@((Candidate 4 '169.254.1.20'),(Candidate 4 '10.1.1.6' 'Tentative'),(Candidate 7 '192.168.0.98' 'Preferred' $true))
if((Select-WarehouseNetwork -Candidates (@($wifi)+$invalid) -DefaultRoutes @()).IPAddress -ne $wifi.IPAddress){throw 'Preferred IPv4 selection failed.'}
$routes=@((Route 7 5 20),(Route 8 5 5))
if((Select-WarehouseNetwork -Candidates @($wifi,$ethernet) -DefaultRoutes $routes).IPAddress -ne $ethernet.IPAddress){throw 'Default route selection failed.'}
AssertRejected {Select-WarehouseNetwork -Candidates @($wifi,$ethernet) -DefaultRoutes @((Route 7 5 5),(Route 8 5 5))} 'more than one'
AssertRejected {Select-WarehouseNetwork -Candidates $invalid -DefaultRoutes @()} 'Connect this computer'
Write-Output 'Warehouse IPv4 selection tests passed.'
