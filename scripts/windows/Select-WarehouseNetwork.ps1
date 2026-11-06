function Select-WarehouseNetwork {
 [CmdletBinding()]
 param(
  [Parameter(Mandatory=$true)][AllowEmptyCollection()][object[]]$Candidates,
  [Parameter(Mandatory=$true)][AllowEmptyCollection()][object[]]$DefaultRoutes
 )
 $eligible=@($Candidates | Where-Object {
  $_.AddressState -eq 'Preferred' -and -not $_.SkipAsSource -and
  $_.IPAddress -notmatch '^(0\.|127\.|169\.254\.)'
 })
 if($eligible.Count -eq 1){return $eligible[0]}
 if($eligible.Count -eq 0){throw 'Connect this computer to the warehouse network and restart setup.'}
 $ranked=@(foreach($candidate in $eligible){
  $route=$DefaultRoutes | Where-Object InterfaceIndex -eq $candidate.InterfaceIndex |
   Sort-Object @{Expression={$_.RouteMetric+$_.InterfaceMetric}} | Select-Object -First 1
  if($route){[pscustomobject]@{Candidate=$candidate;Metric=($route.RouteMetric+$route.InterfaceMetric)}}
 })
 $ranked=@($ranked | Sort-Object Metric)
 if($ranked.Count -eq 1 -or ($ranked.Count -gt 1 -and $ranked[0].Metric -lt $ranked[1].Metric)){
  return $ranked[0].Candidate
 }
 throw 'Setup found more than one possible warehouse connection. Disconnect unused network connections and restart setup.'
}
