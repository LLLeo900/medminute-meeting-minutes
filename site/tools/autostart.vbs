' Silent MedMinute autostart: the site on 7777 and the offline ASR on 7778, without console windows.
' A shortcut to this file goes into the Windows "Startup" folder.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\medminute\site"
sh.Run "cmd /c node server.js > data\server.log 2>&1", 0, False
sh.Run "cmd /c ""C:\Users\user\AppData\Local\Programs\Python\Python313\python.exe"" asr\service.py > data\asr.log 2>&1", 0, False
