[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Setup-Dialogs.ps1')
$dialog=New-SetupAdministratorWindow
try {
 $username=$dialog.FindName('Username')
 $displayName=$dialog.FindName('DisplayName')
 $language=$dialog.FindName('Language')
 $password=$dialog.FindName('Password')
 $confirmation=$dialog.FindName('ConfirmPassword')
 $continue=$dialog.FindName('Continue')
 if($language.SelectedIndex -ne 0 -or $dialog.FindName('UsernameLabel').Text -ne 'Username' -or $username.Text -or $displayName.Text){
  throw 'Initial account setup must open in English with blank names.'
 }
 $continue.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
 if($dialog.FindName('ValidationError').Text -ne 'Enter a username of 1 to 64 characters.' -or $dialog.Tag){throw 'Blank username was accepted.'}
 $username.Text='Warehouse Owner'
 $continue.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
 if($dialog.FindName('ValidationError').Text -ne 'Enter a display name of 1 to 128 characters.' -or $dialog.Tag){throw 'Blank display name was accepted.'}
 $displayName.Text='Customer Administrator'
 $language.SelectedIndex=1
 if($dialog.FindName('UsernameLabel').Text -cne $dialog.Resources['Strings'].zh.Username){throw 'Chinese labels did not load.'}
 $language.SelectedIndex=2
 if($dialog.FindName('UsernameLabel').Text -ne 'Nama pengguna'){throw 'Malay labels did not load.'}
 $language.SelectedIndex=0
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
 if($dialog.ShowDialog() -ne $true -or $dialog.Tag.Password -isnot [Security.SecureString]){throw 'Valid credentials did not complete the setup dialog.'}
 if($dialog.Tag.Password.Length -ne $password.Password.Length){throw 'Password handoff length changed.'}
 if($dialog.Tag.Username -ne $username.Text -or $dialog.Tag.DisplayName -ne $displayName.Text){throw 'Account details changed during setup or language switching.'}
} finally {
 $password.Clear()
 $confirmation.Clear()
 if($dialog.Tag){$dialog.Tag.Password.Dispose()}
 $dialog.Close()
}
$cancel=New-SetupAdministratorWindow
[void]$cancel.Dispatcher.BeginInvoke([Action]{$cancel.Close()})
if($cancel.ShowDialog() -eq $true -or $cancel.Tag){throw 'Cancelled setup returned a password.'}
Write-Output 'Setup language switching, custom administrator validation, secure handoff and cancellation passed.'
