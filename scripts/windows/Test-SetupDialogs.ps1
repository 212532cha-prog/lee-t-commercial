[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Setup-Dialogs.ps1')
$dialog=New-SetupPasswordWindow
try {
 $password=$dialog.FindName('Password')
 $confirmation=$dialog.FindName('ConfirmPassword')
 $continue=$dialog.FindName('Continue')
 $short=[string]::new('x',5)
 $password.Password=$short
 $confirmation.Password=$short
 $continue.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
 if($dialog.FindName('ValidationError').Text -ne 'Use at least 6 characters.' -or $dialog.Tag){throw 'Short password was accepted.'}
 $password.Password=[guid]::NewGuid().ToString('N')
 $confirmation.Password=[guid]::NewGuid().ToString('N')
 $continue.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
 if($dialog.FindName('ValidationError').Text -ne 'The passwords do not match.' -or $dialog.Tag){throw 'Mismatched passwords were accepted.'}
 $confirmation.Password=$password.Password
 [void]$dialog.Dispatcher.BeginInvoke([Action]{
  $continue.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
 })
 if($dialog.ShowDialog() -ne $true -or $dialog.Tag -isnot [Security.SecureString]){throw 'Valid password did not complete the setup dialog.'}
 if($dialog.Tag.Length -ne $password.Password.Length){throw 'Password handoff length changed.'}
} finally {
 $password.Clear()
 $confirmation.Clear()
 if($dialog.Tag){$dialog.Tag.Dispose()}
 $dialog.Close()
}
$cancel=New-SetupPasswordWindow
[void]$cancel.Dispatcher.BeginInvoke([Action]{$cancel.Close()})
if($cancel.ShowDialog() -eq $true -or $cancel.Tag){throw 'Cancelled setup returned a password.'}
Write-Output 'Setup password validation, secure handoff and cancellation passed.'
