/** Embedded console controls; composed into the nonce-protected HTML shell. */
export const controls = String.raw`    function el(tag, text, cls) {
      const item = document.createElement(tag);
      if (text !== undefined) item.textContent = text;
      if (cls) item.className = cls;
      return item;
    }
    function selectedValues(group) {
      return [...document.querySelectorAll('input[data-group="' + group + '"]:checked')].map(x => x.value);
    }
    function checkboxGroup(id, options, values) {
      const root = $(id);
      root.replaceChildren();
      const known = new Set(options.map(x => x.value));
      const available = [...options, ...values.filter(v => !known.has(v)).map(v => ({value:v,label:v + "（当前未登记）"}))];
      if (!available.length) root.append(el("span","暂无已登记条目","muted"));
      for (const option of available) {
        const label = el("label",undefined,"choice");
        const input = el("input");
        input.type = "checkbox";
        input.value = option.value;
        input.dataset.group = id;
        input.checked = values.includes(option.value);
        input.disabled = formMode === "view";
        label.append(input,el("span",option.label));
        root.append(label);
      }
    }
    function setField(id, value) { $(id).value = value === undefined || value === null ? "" : String(value); }
    function numberValue(id) { return Number($(id).value); }
`;
