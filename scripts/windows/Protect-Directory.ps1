function Protect-Directory {
 [CmdletBinding()]
 param(
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true)][ValidateSet('RX','M')][string]$ServiceAccess,
  [switch]$AllowDesktopRead
 )
 $ErrorActionPreference='Stop'
 New-Item -ItemType Directory -Path $Path -Force | Out-Null
 $acl=Get-Acl -LiteralPath $Path
 $acl.SetAccessRuleProtection($true,$false)
 # Replace explicit grants too: an existing broad grant must not survive protection.
 foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
 $inheritance=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
 $propagation=[Security.AccessControl.PropagationFlags]::None
 $allow=[Security.AccessControl.AccessControlType]::Allow
 $serviceRights=if($ServiceAccess -eq 'M'){'Modify'}else{'ReadAndExecute'}
 $grants=@{
  'S-1-5-32-544'='FullControl'
  'S-1-5-18'='FullControl'
  'S-1-5-19'=$serviceRights
 }
 if($AllowDesktopRead){$grants['S-1-5-32-545']='ReadAndExecute'}
 foreach($entry in $grants.GetEnumerator()){
  $identity=[Security.Principal.SecurityIdentifier]::new($entry.Key)
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]$entry.Value,$inheritance,$propagation,$allow)
  $acl.AddAccessRule($rule)
 }
 Set-Acl -LiteralPath $Path -AclObject $acl
}
