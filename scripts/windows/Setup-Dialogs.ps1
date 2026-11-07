function New-SetupPasswordWindow {
 Add-Type -AssemblyName PresentationFramework
 $window=New-Object Windows.Window
 [Windows.NameScope]::SetNameScope($window,(New-Object Windows.NameScope))
 $window.Title='LEE T Warehouse setup'
 $window.Width=440
 $window.SizeToContent='Height'
 $window.ResizeMode='NoResize'
 $window.WindowStartupLocation='CenterScreen'
 $window.Topmost=$true
 $panel=New-Object Windows.Controls.StackPanel
 $panel.Margin='24'
 $heading=New-Object Windows.Controls.TextBlock
 $heading.Text='Create the Administrator password'
 $heading.FontSize=20
 $heading.TextWrapping='Wrap'
 [void]$panel.Children.Add($heading)
 $help=New-Object Windows.Controls.TextBlock
 $help.Text='Use 6 to 128 characters. You will use this password to sign in to LEE T.'
 $help.TextWrapping='Wrap'
 $help.Margin='0,12,0,12'
 [void]$panel.Children.Add($help)
 foreach($item in @(@('Password','Password'),@('ConfirmPassword','Confirm password'))){
  $label=New-Object Windows.Controls.TextBlock
  $label.Text=$item[1]
  [void]$panel.Children.Add($label)
  $box=New-Object Windows.Controls.PasswordBox
  $box.Name=$item[0]
  $box.MaxLength=128
  $box.Margin='0,6,0,12'
  $window.RegisterName($box.Name,$box)
  [void]$panel.Children.Add($box)
 }
 $errorText=New-Object Windows.Controls.TextBlock
 $errorText.Foreground='Firebrick'
 $errorText.TextWrapping='Wrap'
 $window.RegisterName('ValidationError',$errorText)
 [void]$panel.Children.Add($errorText)
 $save=New-Object Windows.Controls.Button
 $save.Content='Continue installation'
 $save.Margin='0,12,0,0'
 $save.Padding='12,8'
 $save.IsDefault=$true
 $window.RegisterName('Continue',$save)
 [void]$panel.Children.Add($save)
 $window.Content=$panel
 $save.Add_Click({
  $dialog=[Windows.Window]::GetWindow($this)
  $password=$dialog.FindName('Password')
  if($password.Password.Length -lt 6){
   $dialog.FindName('ValidationError').Text='Use at least 6 characters.'
  }elseif($password.Password -cne $dialog.FindName('ConfirmPassword').Password){
   $dialog.FindName('ValidationError').Text='The passwords do not match.'
  }else{
   $dialog.Tag=$password.SecurePassword
   $dialog.DialogResult=$true
  }
 })
 $window.Add_ContentRendered({[void]$this.FindName('Password').Focus()})
 return $window
}

function Read-SetupAdministratorPassword {
 $dialog=New-SetupPasswordWindow
 try {
  if($dialog.ShowDialog() -ne $true){throw 'Setup cancelled before database initialization.'}
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($dialog.Tag)
  try{return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}
  finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
 }finally{
  $dialog.FindName('Password').Clear()
  $dialog.FindName('ConfirmPassword').Clear()
  if($dialog.Tag){$dialog.Tag.Dispose();$dialog.Tag=$null}
 }
}
