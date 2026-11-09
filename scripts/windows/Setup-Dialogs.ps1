function New-SetupAdministratorWindow {
 Add-Type -AssemblyName PresentationFramework
 $window=New-Object Windows.Window
 [Windows.NameScope]::SetNameScope($window,(New-Object Windows.NameScope))
 $window.Width=440
 $window.SizeToContent='Height'
 $window.ResizeMode='NoResize'
 $window.WindowStartupLocation='CenterScreen'
 $window.Topmost=$true
 $panel=New-Object Windows.Controls.StackPanel
 $panel.Margin='24'
 $strings=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Setup-Strings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 $window.Resources['Strings']=$strings
 $logo=New-Object Windows.Controls.Image
 $logo.Source=[Windows.Media.Imaging.BitmapImage]::new([uri](Join-Path $PSScriptRoot '..\..\public\brand\lee-t-logo.jpg'))
 $logo.Width=176
 $logo.Height=88
 $logo.HorizontalAlignment='Left'
 [void]$panel.Children.Add($logo)
 $language=New-Object Windows.Controls.ComboBox
 $language.Name='Language'
 $language.Margin='0,0,0,12'
 foreach($item in @(@('en','English'),@('zh',[string]([char]0x4E2D)+[char]0x6587),@('ms','Bahasa Melayu'))){
  $option=New-Object Windows.Controls.ComboBoxItem
  $option.Tag=$item[0]
  $option.Content=$item[1]
  [void]$language.Items.Add($option)
 }
 $window.RegisterName($language.Name,$language)
 [void]$panel.Children.Add($language)
 $heading=New-Object Windows.Controls.TextBlock
 $window.RegisterName('Heading',$heading)
 $heading.FontSize=20
 $heading.TextWrapping='Wrap'
 [void]$panel.Children.Add($heading)
 $help=New-Object Windows.Controls.TextBlock
 $window.RegisterName('Help',$help)
 $help.TextWrapping='Wrap'
 $help.Margin='0,12,0,12'
 [void]$panel.Children.Add($help)
 foreach($name in @('Username','DisplayName','Password','ConfirmPassword')){
  $label=New-Object Windows.Controls.TextBlock
  $window.RegisterName(($name+'Label'),$label)
  [void]$panel.Children.Add($label)
  $box=if($name -in @('Username','DisplayName')){New-Object Windows.Controls.TextBox}else{New-Object Windows.Controls.PasswordBox}
  $box.Name=$name
  $box.MaxLength=if($name -eq 'Username'){64}else{128}
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
 $save.Margin='0,12,0,0'
 $save.Padding='12,8'
 $save.IsDefault=$true
 $window.RegisterName('Continue',$save)
 [void]$panel.Children.Add($save)
 $window.Content=$panel
 $language.Add_SelectionChanged({
  $dialog=[Windows.Window]::GetWindow($this)
  $words=$dialog.Resources['Strings'].($this.SelectedItem.Tag)
  $dialog.Resources['Words']=$words
  $dialog.Title=$words.title
  $dialog.FindName('Heading').Text=$words.heading
  $dialog.FindName('Help').Text=$words.help
  foreach($name in @('Username','DisplayName','Password','ConfirmPassword')){
   $dialog.FindName($name+'Label').Text=$words.$name
  }
  $dialog.FindName('Continue').Content=$words.Continue
  $dialog.FindName('ValidationError').Text=''
 })
 $language.SelectedIndex=0
 $save.Add_Click({
  $dialog=[Windows.Window]::GetWindow($this)
  $words=$dialog.Resources['Words']
  $username=$dialog.FindName('Username').Text.Trim()
  $displayName=$dialog.FindName('DisplayName').Text.Trim()
  $password=$dialog.FindName('Password')
  if(-not $username -or $username -match '[\x00-\x1f\x7f]'){
   $dialog.FindName('ValidationError').Text=$words.usernameError
  }elseif(-not $displayName){
   $dialog.FindName('ValidationError').Text=$words.nameError
  }elseif($password.Password.Length -lt 6){
   $dialog.FindName('ValidationError').Text=$words.shortError
  }elseif($password.Password -cne $dialog.FindName('ConfirmPassword').Password){
   $dialog.FindName('ValidationError').Text=$words.matchError
  }else{
   $dialog.Tag=@{Username=$username;DisplayName=$displayName;Password=$password.SecurePassword}
   $dialog.DialogResult=$true
  }
 })
 $window.Add_ContentRendered({[void]$this.FindName('Username').Focus()})
 return $window
}

function Read-SetupAdministrator {
 $dialog=New-SetupAdministratorWindow
 try {
  if($dialog.ShowDialog() -ne $true){throw 'Setup cancelled before database initialization.'}
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($dialog.Tag.Password)
  try{return @{Username=$dialog.Tag.Username;DisplayName=$dialog.Tag.DisplayName;Password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}}
  finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
 }finally{
  $dialog.FindName('Password').Clear()
  $dialog.FindName('ConfirmPassword').Clear()
  if($dialog.Tag){$dialog.Tag.Password.Dispose();$dialog.Tag=$null}
 }
}
