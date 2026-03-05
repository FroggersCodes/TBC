(function () {
    'use strict';

    // ─── State ──────────────────────────────────────────────
    const STATE_KEY = 'taskflow_state';
    let state = defaultState();
    let calendarOffset = 0; // weeks from current
    let currentWorkspaceId = null;
    let currentUserEmail = null;
    let isWorkspaceOwner = false;
    let snapshotUnsubscribe = null;
    let saveTimeout = null;

    function defaultState() {
        return {
            tasks: [],
            members: [],
            activityLog: [],
        };
    }

    function loadLocalState() {
        try {
            const raw = localStorage.getItem(STATE_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) { /* ignore */ }
        return null;
    }

    async function loadStateFromFirestore(workspaceId) {
        try {
            const doc = await db.collection('workspaces').doc(workspaceId).get();
            if (doc.exists) {
                const data = doc.data();
                return {
                    tasks: data.tasks || [],
                    members: data.members || [],
                    activityLog: data.activityLog || [],
                };
            }
        } catch (e) {
            console.error('Failed to load from Firestore:', e);
        }
        return null;
    }

    function saveState() {
        // Keep localStorage as offline fallback
        localStorage.setItem(STATE_KEY, JSON.stringify(state));

        if (!currentWorkspaceId) return;
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(function () {
            db.collection('workspaces').doc(currentWorkspaceId).set({
                ownerId: currentWorkspaceId === auth.currentUser.uid ? auth.currentUser.uid : undefined,
                ownerEmail: undefined, // preserve existing
                tasks: state.tasks,
                members: state.members,
                activityLog: state.activityLog,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            }, { merge: true }).catch(function (err) {
                console.error('Save failed:', err);
            });
        }, 500);
    }

    function listenToWorkspace(workspaceId) {
        if (snapshotUnsubscribe) snapshotUnsubscribe();
        snapshotUnsubscribe = db.collection('workspaces').doc(workspaceId).onSnapshot(function (doc) {
            if (doc.exists && !doc.metadata.hasPendingWrites) {
                const data = doc.data();
                state.tasks = data.tasks || [];
                state.members = data.members || [];
                state.activityLog = data.activityLog || [];
                renderDashboard();
                renderBoard();
            }
        });
    }

    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function logActivity(message) {
        state.activityLog.unshift({ message, time: new Date().toISOString() });
        if (state.activityLog.length > 50) state.activityLog.length = 50;
        saveState();
    }

    // ─── Navigation ─────────────────────────────────────────
    const navLinks = document.querySelectorAll('.nav-links a');
    const views = document.querySelectorAll('.view');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const view = link.dataset.view;
            navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            views.forEach(v => v.classList.remove('active'));
            document.getElementById('view-' + view).classList.add('active');
            refreshCurrentView(view);
        });
    });

    function refreshCurrentView(view) {
        if (view === 'dashboard') renderDashboard();
        else if (view === 'board') renderBoard();
        else if (view === 'calendar') renderCalendar();
        else if (view === 'delegation') renderDelegation();
    }

    // ─── Task Modal ─────────────────────────────────────────
    const modalTask = document.getElementById('modal-task');
    const formTask = document.getElementById('form-task');
    const btnAddTask = document.getElementById('btn-add-task');
    const btnCancelTask = document.getElementById('btn-cancel-task');
    const modalTaskClose = document.getElementById('modal-task-close');

    btnAddTask.addEventListener('click', () => openTaskModal());
    btnCancelTask.addEventListener('click', () => closeTaskModal());
    modalTaskClose.addEventListener('click', () => closeTaskModal());
    modalTask.addEventListener('click', (e) => {
        if (e.target === modalTask) closeTaskModal();
    });

    function openTaskModal(task) {
        refreshAssigneeSelect();
        if (task) {
            document.getElementById('modal-task-title').textContent = 'Edit Task';
            document.getElementById('task-id').value = task.id;
            document.getElementById('task-title').value = task.title;
            document.getElementById('task-description').value = task.description || '';
            document.getElementById('task-estimate').value = task.estimate || 1;
            document.getElementById('task-priority').value = task.priority || 'medium';
            document.getElementById('task-due').value = task.due || '';
            document.getElementById('task-assignee').value = task.assignee || '';
            document.getElementById('task-status').value = task.status || 'todo';
            renderAISubtasks(task.subtasks || []);
        } else {
            document.getElementById('modal-task-title').textContent = 'New Task';
            formTask.reset();
            document.getElementById('task-id').value = '';
            document.getElementById('task-status').value = 'todo';
            document.getElementById('ai-subtasks').innerHTML = '';
        }
        modalTask.classList.add('active');
    }

    function closeTaskModal() {
        modalTask.classList.remove('active');
    }

    function refreshAssigneeSelect() {
        const select = document.getElementById('task-assignee');
        const currentVal = select.value;
        select.innerHTML = '<option value="">Unassigned</option>';
        state.members.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            select.appendChild(opt);
        });
        select.value = currentVal;
    }

    formTask.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = document.getElementById('task-id').value;
        const taskData = {
            title: document.getElementById('task-title').value.trim(),
            description: document.getElementById('task-description').value.trim(),
            estimate: parseFloat(document.getElementById('task-estimate').value) || 1,
            priority: document.getElementById('task-priority').value,
            due: document.getElementById('task-due').value,
            assignee: document.getElementById('task-assignee').value,
            status: document.getElementById('task-status').value,
        };

        // Collect subtasks
        const subtaskEls = document.querySelectorAll('#ai-subtasks .ai-subtask-item');
        if (subtaskEls.length > 0) {
            taskData.subtasks = Array.from(subtaskEls).map(el => ({
                text: el.querySelector('input[type="text"]').value,
                done: el.querySelector('input[type="checkbox"]').checked,
            }));
        }

        if (id) {
            const idx = state.tasks.findIndex(t => t.id === id);
            if (idx !== -1) {
                state.tasks[idx] = { ...state.tasks[idx], ...taskData };
                logActivity(`Updated task "${taskData.title}"`);
            }
        } else {
            const newTask = { id: generateId(), ...taskData, createdAt: new Date().toISOString() };
            state.tasks.push(newTask);
            logActivity(`Created task "${taskData.title}"`);
        }

        saveState();
        closeTaskModal();
        renderBoard();
        renderDashboard();
    });

    // ─── AI Task Breakdown ──────────────────────────────────
    const btnAIBreakdown = document.getElementById('btn-ai-breakdown');

    btnAIBreakdown.addEventListener('click', () => {
        const title = document.getElementById('task-title').value.trim();
        const description = document.getElementById('task-description').value.trim();
        if (!title) {
            alert('Please enter a task title first.');
            return;
        }
        generateBreakdown(title, description);
    });

    function generateBreakdown(title, description) {
        const container = document.getElementById('ai-subtasks');
        container.innerHTML = '<div class="ai-loading">Analyzing task and generating breakdown...</div>';

        // Simulate AI processing with smart heuristic breakdown
        setTimeout(() => {
            const subtasks = createSmartBreakdown(title, description);
            renderAISubtasks(subtasks);
        }, 800);
    }

    function createSmartBreakdown(title, description) {
        const combined = (title + ' ' + description).toLowerCase();
        const subtasks = [];

        // Pattern-based intelligent breakdown
        const patterns = [
            {
                keywords: ['page', 'screen', 'view', 'ui', 'interface', 'layout', 'design', 'component', 'form', 'modal'],
                tasks: ['Design wireframe/mockup', 'Build HTML structure', 'Add CSS styling', 'Implement interactivity', 'Test responsiveness'],
            },
            {
                keywords: ['api', 'endpoint', 'backend', 'server', 'database', 'query'],
                tasks: ['Define API schema/contract', 'Set up route handlers', 'Implement business logic', 'Add input validation', 'Write integration tests'],
            },
            {
                keywords: ['bug', 'fix', 'error', 'issue', 'broken', 'crash'],
                tasks: ['Reproduce the issue', 'Identify root cause', 'Implement fix', 'Add regression test', 'Verify in staging'],
            },
            {
                keywords: ['test', 'testing', 'qa', 'quality'],
                tasks: ['Write unit tests', 'Write integration tests', 'Perform manual QA', 'Fix failing tests', 'Update test documentation'],
            },
            {
                keywords: ['deploy', 'release', 'launch', 'ship', 'publish'],
                tasks: ['Run full test suite', 'Update version/changelog', 'Build production artifacts', 'Deploy to staging', 'Deploy to production'],
            },
            {
                keywords: ['auth', 'login', 'signup', 'register', 'password', 'user'],
                tasks: ['Design auth flow', 'Build login/signup forms', 'Implement validation logic', 'Add session management', 'Test edge cases'],
            },
            {
                keywords: ['refactor', 'clean', 'improve', 'optimize', 'restructure'],
                tasks: ['Identify areas to refactor', 'Plan new structure', 'Implement changes', 'Update dependent code', 'Verify no regressions'],
            },
            {
                keywords: ['document', 'docs', 'readme', 'guide', 'wiki'],
                tasks: ['Outline document structure', 'Write initial draft', 'Add code examples', 'Review and edit', 'Publish documentation'],
            },
        ];

        for (const pattern of patterns) {
            if (pattern.keywords.some(kw => combined.includes(kw))) {
                return pattern.tasks.map(t => ({ text: t, done: false }));
            }
        }

        // Generic breakdown based on task complexity
        const estimate = parseFloat(document.getElementById('task-estimate').value) || 1;
        if (estimate <= 2) {
            return [
                { text: 'Plan approach', done: false },
                { text: 'Implement core changes', done: false },
                { text: 'Test and verify', done: false },
            ];
        }
        return [
            { text: 'Research and plan approach', done: false },
            { text: 'Set up prerequisites', done: false },
            { text: 'Implement core functionality', done: false },
            { text: 'Add error handling and edge cases', done: false },
            { text: 'Test thoroughly', done: false },
            { text: 'Code review and cleanup', done: false },
        ];
    }

    function renderAISubtasks(subtasks) {
        const container = document.getElementById('ai-subtasks');
        container.innerHTML = '';
        subtasks.forEach((st, i) => {
            const div = document.createElement('div');
            div.className = 'ai-subtask-item';
            div.innerHTML = `
                <input type="checkbox" ${st.done ? 'checked' : ''} data-idx="${i}">
                <input type="text" value="${escapeHtml(st.text)}">
                <button type="button" class="btn btn-small btn-danger" data-remove="${i}">&times;</button>
            `;
            container.appendChild(div);
        });

        // Add "add subtask" button
        if (subtasks.length > 0) {
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'btn btn-small btn-secondary';
            addBtn.textContent = '+ Add Subtask';
            addBtn.style.marginTop = '8px';
            addBtn.addEventListener('click', () => {
                const items = Array.from(container.querySelectorAll('.ai-subtask-item'));
                const newSubtasks = items.map(el => ({
                    text: el.querySelector('input[type="text"]').value,
                    done: el.querySelector('input[type="checkbox"]').checked,
                }));
                newSubtasks.push({ text: '', done: false });
                renderAISubtasks(newSubtasks);
            });
            container.appendChild(addBtn);
        }

        // Remove handlers
        container.querySelectorAll('[data-remove]').forEach(btn => {
            btn.addEventListener('click', () => {
                const items = Array.from(container.querySelectorAll('.ai-subtask-item'));
                const current = items.map(el => ({
                    text: el.querySelector('input[type="text"]').value,
                    done: el.querySelector('input[type="checkbox"]').checked,
                }));
                current.splice(parseInt(btn.dataset.remove), 1);
                renderAISubtasks(current);
            });
        });
    }

    // ─── Board (Kanban) ─────────────────────────────────────
    function renderBoard() {
        const statuses = ['todo', 'in-progress', 'review', 'done'];
        statuses.forEach(status => {
            const col = document.querySelector(`.column-body[data-status="${status}"]`);
            col.innerHTML = '';
            const tasks = state.tasks.filter(t => t.status === status);
            document.getElementById('count-' + status).textContent = tasks.length;

            tasks.forEach(task => {
                col.appendChild(createTaskCard(task));
            });
        });
        setupDragAndDrop();
    }

    function createTaskCard(task) {
        const card = document.createElement('div');
        card.className = 'task-card';
        card.draggable = true;
        card.dataset.taskId = task.id;

        const assigneeName = task.assignee
            ? (state.members.find(m => m.id === task.assignee)?.name || 'Unknown')
            : '';

        const dueClass = task.due && new Date(task.due) < new Date() && task.status !== 'done' ? 'overdue' : '';
        const dueText = task.due ? formatDate(task.due) : '';

        let subtasksHtml = '';
        if (task.subtasks && task.subtasks.length > 0) {
            const doneCount = task.subtasks.filter(s => s.done).length;
            subtasksHtml = `
                <div class="task-subtasks">
                    ${task.subtasks.map((st, i) => `
                        <div class="subtask-item ${st.done ? 'completed' : ''}">
                            <input type="checkbox" ${st.done ? 'checked' : ''} data-task-id="${task.id}" data-subtask-idx="${i}">
                            <span>${escapeHtml(st.text)}</span>
                        </div>
                    `).join('')}
                    <div style="font-size:0.7rem;color:var(--text-secondary);margin-top:4px">${doneCount}/${task.subtasks.length} completed</div>
                </div>
            `;
        }

        card.innerHTML = `
            <div class="task-card-header">
                <span class="task-card-title">${escapeHtml(task.title)}</span>
                <div class="task-card-actions">
                    <button data-edit="${task.id}" title="Edit">&#9998;</button>
                    <button data-delete="${task.id}" title="Delete">&times;</button>
                </div>
            </div>
            ${task.description ? `<div class="task-card-desc">${escapeHtml(task.description)}</div>` : ''}
            <div class="task-card-meta">
                <span class="task-badge badge-estimate">${task.estimate}h</span>
                <span class="task-badge badge-priority-${task.priority}">${task.priority}</span>
                ${assigneeName ? `<span class="task-badge badge-assignee">${escapeHtml(assigneeName)}</span>` : ''}
            </div>
            ${dueText ? `<div class="task-due ${dueClass}">${dueText}</div>` : ''}
            ${subtasksHtml}
        `;

        // Edit button
        card.querySelector(`[data-edit="${task.id}"]`).addEventListener('click', (e) => {
            e.stopPropagation();
            openTaskModal(task);
        });

        // Delete button
        card.querySelector(`[data-delete="${task.id}"]`).addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Delete this task?')) {
                state.tasks = state.tasks.filter(t => t.id !== task.id);
                logActivity(`Deleted task "${task.title}"`);
                saveState();
                renderBoard();
                renderDashboard();
            }
        });

        // Subtask checkboxes
        card.querySelectorAll('[data-subtask-idx]').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const taskId = e.target.dataset.taskId;
                const idx = parseInt(e.target.dataset.subtaskIdx);
                const t = state.tasks.find(t => t.id === taskId);
                if (t && t.subtasks && t.subtasks[idx] !== undefined) {
                    t.subtasks[idx].done = e.target.checked;
                    saveState();
                    renderBoard();
                }
            });
        });

        return card;
    }

    // ─── Drag and Drop ──────────────────────────────────────
    function setupDragAndDrop() {
        const cards = document.querySelectorAll('.task-card');
        const columns = document.querySelectorAll('.column-body');

        cards.forEach(card => {
            card.addEventListener('dragstart', (e) => {
                card.classList.add('dragging');
                e.dataTransfer.setData('text/plain', card.dataset.taskId);
            });
            card.addEventListener('dragend', () => {
                card.classList.remove('dragging');
                columns.forEach(col => col.classList.remove('drag-over'));
            });
        });

        columns.forEach(col => {
            col.addEventListener('dragover', (e) => {
                e.preventDefault();
                col.classList.add('drag-over');
            });
            col.addEventListener('dragleave', () => {
                col.classList.remove('drag-over');
            });
            col.addEventListener('drop', (e) => {
                e.preventDefault();
                col.classList.remove('drag-over');
                const taskId = e.dataTransfer.getData('text/plain');
                const newStatus = col.dataset.status;
                const task = state.tasks.find(t => t.id === taskId);
                if (task && task.status !== newStatus) {
                    const oldStatus = task.status;
                    task.status = newStatus;
                    logActivity(`Moved "${task.title}" from ${formatStatus(oldStatus)} to ${formatStatus(newStatus)}`);
                    saveState();
                    renderBoard();
                    renderDashboard();
                }
            });
        });
    }

    // ─── Calendar ───────────────────────────────────────────
    const btnPrevWeek = document.getElementById('btn-prev-week');
    const btnNextWeek = document.getElementById('btn-next-week');

    btnPrevWeek.addEventListener('click', () => { calendarOffset--; renderCalendar(); });
    btnNextWeek.addEventListener('click', () => { calendarOffset++; renderCalendar(); });

    function renderCalendar() {
        const grid = document.getElementById('calendar-grid');
        const label = document.getElementById('calendar-week-label');
        const suggestionsBar = document.getElementById('calendar-suggestions');
        grid.innerHTML = '';

        const today = new Date();
        const startOfWeek = new Date(today);
        startOfWeek.setDate(today.getDate() - today.getDay() + 1 + calendarOffset * 7); // Monday

        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(startOfWeek.getDate() + 6);

        label.textContent = `${formatDateShort(startOfWeek)} - ${formatDateShort(endOfWeek)}`;

        const dailyCapacity = 8; // hours per day
        const suggestions = [];
        const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

        for (let i = 0; i < 7; i++) {
            const date = new Date(startOfWeek);
            date.setDate(startOfWeek.getDate() + i);
            const dateStr = date.toISOString().split('T')[0];
            const isToday = dateStr === today.toISOString().split('T')[0];

            // Find tasks due on this day
            const dayTasks = state.tasks.filter(t => t.due === dateStr && t.status !== 'done');
            const totalHours = dayTasks.reduce((sum, t) => sum + (t.estimate || 1), 0);
            const loadPercent = Math.min((totalHours / dailyCapacity) * 100, 100);
            const loadClass = loadPercent > 80 ? 'load-heavy' : loadPercent > 50 ? 'load-medium' : 'load-light';
            const isOverloaded = totalHours > dailyCapacity;

            if (isOverloaded) {
                suggestions.push(`${dayNames[i]} is overloaded (${totalHours}h / ${dailyCapacity}h capacity). Consider moving tasks.`);
            }

            const dayEl = document.createElement('div');
            dayEl.className = `calendar-day ${isToday ? 'today' : ''} ${isOverloaded ? 'overloaded' : ''}`;
            dayEl.innerHTML = `
                <div class="calendar-day-header">${dayNames[i]}</div>
                <div class="calendar-day-date">${date.getDate()}</div>
                <div class="load-label">${totalHours}h / ${dailyCapacity}h</div>
                <div class="load-bar">
                    <div class="load-bar-fill ${loadClass}" style="width:${loadPercent}%"></div>
                </div>
                ${dayTasks.map(t => `<div class="calendar-task">${escapeHtml(t.title)} (${t.estimate}h)</div>`).join('')}
            `;
            grid.appendChild(dayEl);
        }

        // Check for tasks with no due date
        const noDueTasks = state.tasks.filter(t => !t.due && t.status !== 'done');
        if (noDueTasks.length > 0) {
            suggestions.push(`${noDueTasks.length} task(s) have no due date. Consider scheduling them.`);
        }

        // Check for light days
        const lightDays = [];
        for (let i = 0; i < 5; i++) { // weekdays only
            const date = new Date(startOfWeek);
            date.setDate(startOfWeek.getDate() + i);
            const dateStr = date.toISOString().split('T')[0];
            const dayTasks = state.tasks.filter(t => t.due === dateStr && t.status !== 'done');
            const totalHours = dayTasks.reduce((sum, t) => sum + (t.estimate || 1), 0);
            if (totalHours < dailyCapacity * 0.3) {
                lightDays.push(dayNames[i]);
            }
        }
        if (lightDays.length > 0 && state.tasks.some(t => !t.due && t.status !== 'done')) {
            suggestions.push(`${lightDays.join(', ')} look(s) light. Great time to schedule unassigned tasks.`);
        }

        if (suggestions.length > 0) {
            suggestionsBar.innerHTML = `
                <h4>Suggestions</h4>
                ${suggestions.map(s => `<div class="suggestion-item">${s}</div>`).join('')}
            `;
            suggestionsBar.classList.add('visible');
        } else {
            suggestionsBar.classList.remove('visible');
        }
    }

    // ─── Delegation ─────────────────────────────────────────
    const modalMember = document.getElementById('modal-member');
    const formMember = document.getElementById('form-member');
    const btnAddMember = document.getElementById('btn-add-member');
    const btnCancelMember = document.getElementById('btn-cancel-member');
    const modalMemberClose = document.getElementById('modal-member-close');

    btnAddMember.addEventListener('click', () => modalMember.classList.add('active'));
    btnCancelMember.addEventListener('click', () => modalMember.classList.remove('active'));
    modalMemberClose.addEventListener('click', () => modalMember.classList.remove('active'));
    modalMember.addEventListener('click', (e) => {
        if (e.target === modalMember) modalMember.classList.remove('active');
    });

    formMember.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('member-name').value.trim();
        const capacity = parseInt(document.getElementById('member-capacity').value) || 40;
        if (!name) return;

        state.members.push({ id: generateId(), name, capacity });
        logActivity(`Added team member "${name}"`);
        saveState();
        modalMember.classList.remove('active');
        formMember.reset();
        renderDelegation();
    });

    function renderDelegation() {
        const teamGrid = document.getElementById('team-members');
        const unassignedList = document.getElementById('unassigned-tasks');

        // Render team cards
        teamGrid.innerHTML = '';
        state.members.forEach(member => {
            const assignedTasks = state.tasks.filter(t => t.assignee === member.id);
            const totalHours = assignedTasks.reduce((sum, t) => sum + (t.estimate || 1), 0);

            const card = document.createElement('div');
            card.className = 'team-card';
            card.innerHTML = `
                <div class="team-card-header">
                    <h4>${escapeHtml(member.name)}</h4>
                    <div>
                        <span class="team-card-capacity">${totalHours}h / ${member.capacity}h</span>
                        <button class="btn btn-small btn-danger" data-remove-member="${member.id}" style="margin-left:8px">&times;</button>
                    </div>
                </div>
                <ul class="team-task-list">
                    ${assignedTasks.length === 0 ? '<li style="color:var(--text-secondary);font-size:0.85rem;padding:6px 0">No tasks assigned</li>' : ''}
                    ${assignedTasks.map(t => `
                        <li class="team-task-item">
                            <span>${escapeHtml(t.title)} (${t.estimate}h)</span>
                            <button class="btn btn-small" data-unassign="${t.id}">Unassign</button>
                        </li>
                    `).join('')}
                </ul>
            `;

            card.querySelector(`[data-remove-member="${member.id}"]`).addEventListener('click', () => {
                if (confirm(`Remove ${member.name}? Their tasks will be unassigned.`)) {
                    state.tasks.forEach(t => {
                        if (t.assignee === member.id) t.assignee = '';
                    });
                    state.members = state.members.filter(m => m.id !== member.id);
                    logActivity(`Removed team member "${member.name}"`);
                    saveState();
                    renderDelegation();
                }
            });

            card.querySelectorAll('[data-unassign]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const task = state.tasks.find(t => t.id === btn.dataset.unassign);
                    if (task) {
                        task.assignee = '';
                        logActivity(`Unassigned "${task.title}" from ${member.name}`);
                        saveState();
                        renderDelegation();
                    }
                });
            });

            teamGrid.appendChild(card);
        });

        // Unassigned tasks
        const unassigned = state.tasks.filter(t => !t.assignee && t.status !== 'done');
        unassignedList.innerHTML = '';
        if (unassigned.length === 0) {
            unassignedList.innerHTML = '<div style="color:var(--text-secondary);font-size:0.9rem;padding:8px">All tasks are assigned!</div>';
        }
        unassigned.forEach(task => {
            const item = document.createElement('div');
            item.className = 'delegation-task-item';
            item.innerHTML = `
                <div class="delegation-task-info">
                    <div class="delegation-task-title">${escapeHtml(task.title)}</div>
                    <div class="delegation-task-meta">${task.estimate}h - ${task.priority} priority</div>
                </div>
                <div class="delegation-task-actions">
                    <select data-assign-task="${task.id}">
                        <option value="">Assign to...</option>
                        ${state.members.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')}
                    </select>
                </div>
            `;

            item.querySelector(`[data-assign-task="${task.id}"]`).addEventListener('change', (e) => {
                if (e.target.value) {
                    task.assignee = e.target.value;
                    const member = state.members.find(m => m.id === e.target.value);
                    logActivity(`Assigned "${task.title}" to ${member ? member.name : 'someone'}`);
                    saveState();
                    renderDelegation();
                }
            });

            unassignedList.appendChild(item);
        });
    }

    // ─── Dashboard ──────────────────────────────────────────
    function renderDashboard() {
        const total = state.tasks.length;
        const todo = state.tasks.filter(t => t.status === 'todo').length;
        const progress = state.tasks.filter(t => t.status === 'in-progress').length;
        const review = state.tasks.filter(t => t.status === 'review').length;
        const done = state.tasks.filter(t => t.status === 'done').length;
        const totalHours = state.tasks.reduce((s, t) => s + (t.estimate || 0), 0);
        const completedHours = state.tasks.filter(t => t.status === 'done').reduce((s, t) => s + (t.estimate || 0), 0);

        document.getElementById('stat-total').textContent = total;
        document.getElementById('stat-todo').textContent = todo;
        document.getElementById('stat-progress').textContent = progress + review;
        document.getElementById('stat-done').textContent = done;
        document.getElementById('stat-hours').textContent = totalHours + 'h';
        document.getElementById('stat-completed-hours').textContent = completedHours + 'h';

        // Distribution chart
        const chartArea = document.getElementById('distribution-chart');
        const maxVal = Math.max(todo, progress + review, done, 1);
        const bars = [
            { label: 'To Do', value: todo, color: 'var(--blue)' },
            { label: 'In Progress', value: progress + review, color: 'var(--yellow)' },
            { label: 'Done', value: done, color: 'var(--green)' },
        ];
        chartArea.innerHTML = bars.map(b => `
            <div class="chart-bar-group">
                <div class="chart-bar-value">${b.value}</div>
                <div class="chart-bar" style="height:${Math.max((b.value / maxVal) * 160, 4)}px;background:${b.color}"></div>
                <div class="chart-bar-label">${b.label}</div>
            </div>
        `).join('');

        // Activity feed
        const feed = document.getElementById('activity-feed');
        if (state.activityLog.length === 0) {
            feed.innerHTML = '<div class="activity-item">No activity yet. Create your first task!</div>';
        } else {
            feed.innerHTML = state.activityLog.slice(0, 15).map(a => `
                <div class="activity-item">
                    ${escapeHtml(a.message)}
                    <div class="activity-time">${timeAgo(a.time)}</div>
                </div>
            `).join('');
        }
    }

    // ─── Helpers ────────────────────────────────────────────
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatDate(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    function formatDateShort(date) {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function formatStatus(status) {
        const map = { 'todo': 'To Do', 'in-progress': 'In Progress', 'review': 'Review', 'done': 'Done' };
        return map[status] || status;
    }

    function timeAgo(isoStr) {
        const diff = Date.now() - new Date(isoStr).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + 'm ago';
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + 'h ago';
        const days = Math.floor(hrs / 24);
        return days + 'd ago';
    }

    // ─── Migration ─────────────────────────────────────────
    async function handleMigration(uid) {
        const firestoreData = await loadStateFromFirestore(uid);
        const localData = loadLocalState();

        if (firestoreData) {
            // Cloud data exists — use it
            state = firestoreData;
            return;
        }

        if (localData && (localData.tasks.length > 0 || localData.members.length > 0)) {
            // No cloud data but local data exists — prompt import
            return new Promise(function (resolve) {
                const modal = document.getElementById('modal-migrate');
                modal.classList.add('active');

                document.getElementById('btn-migrate-import').onclick = async function () {
                    state = localData;
                    await db.collection('workspaces').doc(uid).set({
                        ownerId: uid,
                        ownerEmail: currentUserEmail,
                        tasks: state.tasks,
                        members: state.members,
                        activityLog: state.activityLog,
                        sharedWith: [],
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    });
                    localStorage.setItem(STATE_KEY + '_migrated', localStorage.getItem(STATE_KEY));
                    modal.classList.remove('active');
                    resolve();
                };

                document.getElementById('btn-migrate-skip').onclick = async function () {
                    state = defaultState();
                    await db.collection('workspaces').doc(uid).set({
                        ownerId: uid,
                        ownerEmail: currentUserEmail,
                        tasks: [],
                        members: [],
                        activityLog: [],
                        sharedWith: [],
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    });
                    modal.classList.remove('active');
                    resolve();
                };
            });
        }

        // No data anywhere — create empty workspace
        state = defaultState();
        await db.collection('workspaces').doc(uid).set({
            ownerId: uid,
            ownerEmail: currentUserEmail,
            tasks: [],
            members: [],
            activityLog: [],
            sharedWith: [],
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
    }

    // ─── Sharing ─────────────────────────────────────────────
    const modalShare = document.getElementById('modal-share');
    const formShare = document.getElementById('form-share');
    const btnShareWorkspace = document.getElementById('btn-share-workspace');
    const modalShareClose = document.getElementById('modal-share-close');

    btnShareWorkspace.addEventListener('click', function () {
        renderSharedUsers();
        modalShare.classList.add('active');
    });
    modalShareClose.addEventListener('click', function () {
        modalShare.classList.remove('active');
    });
    modalShare.addEventListener('click', function (e) {
        if (e.target === modalShare) modalShare.classList.remove('active');
    });

    formShare.addEventListener('submit', function (e) {
        e.preventDefault();
        const email = document.getElementById('share-email').value.trim();
        if (!email || !currentWorkspaceId) return;

        db.collection('workspaces').doc(currentWorkspaceId).update({
            sharedWith: firebase.firestore.FieldValue.arrayUnion(email)
        }).then(function () {
            document.getElementById('share-email').value = '';
            logActivity('Shared workspace with ' + email);
            renderSharedUsers();
        }).catch(function (err) {
            alert('Failed to share: ' + err.message);
        });
    });

    function renderSharedUsers() {
        const list = document.getElementById('shared-users-list');
        db.collection('workspaces').doc(currentWorkspaceId).get().then(function (doc) {
            if (!doc.exists) return;
            const shared = doc.data().sharedWith || [];
            if (shared.length === 0) {
                list.innerHTML = '<p style="color:var(--text-secondary);font-size:0.85rem;margin-top:12px">Not shared with anyone yet.</p>';
                return;
            }
            list.innerHTML = '<h4 style="margin-top:16px;margin-bottom:8px;font-size:0.9rem">Shared with</h4>' +
                shared.map(function (email) {
                    return '<div class="shared-user-item">' +
                        '<span>' + escapeHtml(email) + '</span>' +
                        '<button class="btn btn-small btn-danger" data-unshare="' + escapeHtml(email) + '">&times;</button>' +
                        '</div>';
                }).join('');

            list.querySelectorAll('[data-unshare]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var emailToRemove = btn.dataset.unshare;
                    db.collection('workspaces').doc(currentWorkspaceId).update({
                        sharedWith: firebase.firestore.FieldValue.arrayRemove(emailToRemove)
                    }).then(function () {
                        logActivity('Removed sharing with ' + emailToRemove);
                        renderSharedUsers();
                    });
                });
            });
        });
    }

    // ─── Workspace Switcher ──────────────────────────────────
    const workspaceSwitcher = document.getElementById('workspace-switcher');
    const workspaceSelect = document.getElementById('workspace-select');

    async function loadSharedWorkspaces(userEmail, uid) {
        const options = [{ id: uid, label: 'My Workspace' }];

        try {
            const snap = await db.collection('workspaces')
                .where('sharedWith', 'array-contains', userEmail)
                .get();
            snap.docs.forEach(function (doc) {
                if (doc.id !== uid) {
                    options.push({
                        id: doc.id,
                        label: (doc.data().ownerEmail || 'Shared') + "'s workspace"
                    });
                }
            });
        } catch (e) {
            console.error('Failed to load shared workspaces:', e);
        }

        if (options.length > 1) {
            workspaceSelect.innerHTML = options.map(function (opt) {
                var selected = opt.id === currentWorkspaceId ? ' selected' : '';
                return '<option value="' + opt.id + '"' + selected + '>' + escapeHtml(opt.label) + '</option>';
            }).join('');
            workspaceSwitcher.style.display = 'block';
        } else {
            workspaceSwitcher.style.display = 'none';
        }
    }

    workspaceSelect.addEventListener('change', async function () {
        const newId = workspaceSelect.value;
        if (newId === currentWorkspaceId) return;

        currentWorkspaceId = newId;
        isWorkspaceOwner = (newId === auth.currentUser.uid);
        btnShareWorkspace.style.display = isWorkspaceOwner ? 'block' : 'none';

        const data = await loadStateFromFirestore(newId);
        state = data || defaultState();
        listenToWorkspace(newId);
        renderDashboard();
        renderBoard();
    });

    // ─── Init ───────────────────────────────────────────────
    window.addEventListener('auth-ready', async function (e) {
        const uid = e.detail.uid;
        currentUserEmail = e.detail.email;
        currentWorkspaceId = uid;
        isWorkspaceOwner = true;

        await handleMigration(uid);

        // Show share button for own workspace
        btnShareWorkspace.style.display = 'block';

        // Load shared workspaces
        loadSharedWorkspaces(currentUserEmail, uid);

        // Listen for real-time updates
        listenToWorkspace(uid);

        renderDashboard();
        renderBoard();
    });
})();
