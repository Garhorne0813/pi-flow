/** Embedded Skill ZIP uploader for the standalone management console. */
export const skillUpload = String.raw`    let zipDragDepth = 0;
    function canSelectSkillZip() { return !!token && !busy && !!(configuration && configuration.skillUploads && configuration.skillUploads.enabled); }
    function renderSkillZip() {
      $("skill-zip-dropzone").setAttribute("aria-disabled",String(!canSelectSkillZip()));
      $("skill-zip").disabled = !canSelectSkillZip();
      $("skill-zip-dropzone").className = "zip-dropzone" + (canSelectSkillZip() && zipDragDepth ? " dragging" : "");
      const file = $("skill-zip").files?.[0];
      $("skill-zip-selection").textContent = file ? "已选择：" + file.name + "（" + (file.size / 1024).toFixed(1) + " KiB）。点击上传并登记版本。" : "也可点击选择文件，填写版本信息后点击上传。";
    }
    function resetSkillZip() { zipDragDepth = 0;renderSkillZip(); }
    function skillZipError(files) {
      if (files.length !== 1) return "请一次选择一个 Skill ZIP 文件。";
      if (!/\.zip$/i.test(files[0].name)) return "请选择 .zip 格式的 Skill 包。";
      if (files[0].size > configuration.skillUploads.maxArchiveBytes) return "ZIP 文件超过上传大小限制。";
      return "";
    }
    $("skill-zip").addEventListener("change",()=>{
      if (!canSelectSkillZip()) return;
      const files = [...$("skill-zip").files];
      if (files.length) {
        const error = skillZipError(files);
        if (error) {$("skill-zip").value = "";notify(error,true);} else resetMessage();
      }
      resetSkillZip();
    });
    for (const type of ["dragenter","dragover","dragleave","drop"]) $("skill-zip-dropzone").addEventListener(type,event=>{
      event.preventDefault();
      if (type === "dragleave") {zipDragDepth = Math.max(0,zipDragDepth - 1);renderSkillZip();return;}
      if (type === "drop") {
        zipDragDepth = 0;
        if (!canSelectSkillZip()) {renderSkillZip();return;}
        const files = [...(event.dataTransfer?.files || [])];
        const directory = [...(event.dataTransfer?.items || [])].some(item=>item.webkitGetAsEntry?.()?.isDirectory);
        const error = directory ? "请拖入 ZIP 文件，不支持直接拖入文件夹。" : skillZipError(files);
        if (error) {notify(error,true);renderSkillZip();return;}
        const transfer = new DataTransfer();transfer.items.add(files[0]);
        $("skill-zip").files = transfer.files;resetMessage();renderSkillZip();return;
      }
      if (event.dataTransfer) event.dataTransfer.dropEffect = canSelectSkillZip() ? "copy" : "none";
      if (type === "dragenter" && canSelectSkillZip()) zipDragDepth++;
      renderSkillZip();
    });
    // Dropping outside the target must not navigate away and discard form drafts.
    for (const type of ["dragover","drop"]) document.addEventListener?.(type,event=>{
      if ([...(event.dataTransfer?.types || [])].includes("Files")) {event.preventDefault();if (type === "drop") resetSkillZip();}
    });
    $("skill-upload-form").addEventListener("submit",event=>{
      event.preventDefault();
      if (!token || busy || !(configuration && configuration.skillUploads && configuration.skillUploads.enabled)) return;
      const file = $("skill-zip").files[0];
      if (!file) return notify("请选择包含一个 Skill 的 ZIP 包。",true);
      const error = skillZipError([file]);
      if (error) return notify(error,true);
      const form = new FormData();
      form.append("id",$("upload-skill-id").value.trim());form.append("name",$("upload-skill-name").value.trim());
      form.append("description",$("upload-skill-description").value);form.append("bundle",$("upload-skill-bundle").value);
      form.append("archive",file);
      notify("正在上传并校验 Skill ZIP…");
      return consoleMutation("/admin/skills/upload","POST",form,"Skill ZIP 已上传并登记，可在 Agent 中选择此版本。",created=>{skills.push(created);$("skill-upload-form").reset();resetSkillZip();});
    });
`;
