
import { useState, useCallback, useEffect } from 'react';
import { 
    collection, query, where, getDocs, doc, getDoc, 
    orderBy, limit, startAfter, QueryDocumentSnapshot,
    updateDoc, arrayUnion, arrayRemove, increment, addDoc, serverTimestamp, setDoc, writeBatch, documentId
} from 'firebase/firestore';
import { db } from '../components/firebaseClient';
import { useToast } from '../contexts/ToastContext';
import type { Module, Quiz, Activity, TeacherClass, User, ActivitySubmission } from '../types';
import { createNotification } from '../utils/createNotification';
import { processGamificationEvent } from '../utils/gamificationEngine';

const ACTIVITIES_PER_PAGE = 10;

export function useStudentContent(user: User | null) {
    const { addToast } = useToast();
    
    // Estados separados para diferentes tipos de dados
    const [inProgressModules, setInProgressModules] = useState<Module[]>([]);
    const [searchedModules, setSearchedModules] = useState<Module[]>([]);
    const [searchedQuizzes, setSearchedQuizzes] = useState<Quiz[]>([]);
    
    // Filtros persistidos
    const [moduleFilters, setModuleFilters] = useState({
        queryText: '',
        serie: 'all',
        materia: 'all',
        status: 'Em andamento',
        scope: 'my_modules' as 'my_modules' | 'public'
    });
    
    const [activities, setActivities] = useState<Activity[]>([]);
    const [studentClasses, setStudentClasses] = useState<TeacherClass[]>([]);
    
    const [isLoading, setIsLoading] = useState(true);
    const [isSearchingModules, setIsSearchingModules] = useState(false);
    const [isSearchingQuizzes, setIsSearchingQuizzes] = useState(false);
    
    // Pagination States
    const [lastActivityDoc, setLastActivityDoc] = useState<QueryDocumentSnapshot | null>(null);
    const [hasMoreActivities, setHasMoreActivities] = useState(false);
    const [isLoadingMoreActivities, setIsLoadingMoreActivities] = useState(false);

    // --- CORE REFRESH LOGIC (Graceful Degradation) ---
    const refreshContent = useCallback(async (forceRefresh = false) => {
        if (!user || user.role !== 'aluno') {
            setIsLoading(false);
            return;
        }
        
        setIsLoading(true);

        // 1. Função independente para buscar turmas
        const fetchClasses = async () => {
            try {
                const classesQuery = query(
                    collection(db, "classes"), 
                    where("studentIds", "array-contains", user.id)
                );
                const classesSnap = await getDocs(classesQuery);

                const myClasses: TeacherClass[] = [];
                
                classesSnap.docs.forEach(d => {
                    const data = d.data();
                    const studentRecord = (data.students || []).find((s: any) => s.id === user.id);
                    if (!studentRecord || studentRecord.status !== 'inactive') {
                        const notices = (Array.isArray(data.notices) ? data.notices : []).map((n: any) => ({
                            ...n,
                            timestamp: n.timestamp?.toDate ? n.timestamp.toDate().toISOString() : n.timestamp
                        }));
                        myClasses.push({ id: d.id, ...data, notices } as TeacherClass);
                    }
                });
                
                setStudentClasses(myClasses);
            } catch (error: any) {
                console.warn("Falha parcial ao carregar turmas:", error);
                if (error.code !== 'permission-denied') {
                    addToast("Não foi possível carregar suas turmas.", "error");
                }
                setStudentClasses([]);
            }
        };

        // 2. Função independente para buscar progresso de módulos
        const fetchProgress = async () => {
            try {
                const progressColRef = collection(db, "users", user.id, "modulesProgress");
                const progressSnap = await getDocs(progressColRef);
                
                const modulesToFetch: string[] = [];
                const progressMap: Record<string, number> = {};

                progressSnap.forEach(doc => {
                    const data = doc.data();
                    if (data.progress > 0 && data.progress < 100) {
                        modulesToFetch.push(doc.id);
                        progressMap[doc.id] = data.progress;
                    }
                });

                if (modulesToFetch.length > 0) {
                    const chunks = [];
                    for (let i = 0; i < modulesToFetch.length; i += 10) {
                        chunks.push(modulesToFetch.slice(i, i + 10));
                    }

                    const fetchedModules: Module[] = [];
                    for (const chunk of chunks) {
                        const q = query(collection(db, "modules"), where(documentId(), "in", chunk));
                        const snap = await getDocs(q);
                        snap.forEach(d => {
                            fetchedModules.push({ 
                                id: d.id, 
                                ...d.data(), 
                                progress: progressMap[d.id] 
                            } as Module);
                        });
                    }
                    setInProgressModules(fetchedModules);
                } else {
                    setInProgressModules([]);
                }
            } catch (error: any) {
                console.warn("Falha parcial ao carregar progresso:", error);
                setInProgressModules([]);
            }
        };

        // Executa em paralelo, se um falhar o outro continua
        await Promise.allSettled([fetchClasses(), fetchProgress()]);
        
        setIsLoading(false);
    }, [user, addToast]);

    useEffect(() => {
        if (user) {
            refreshContent();
        }
    }, [user, refreshContent]);


    // --- SEARCH MODULES (On Demand) ---
    const searchModules = useCallback(async (filters: { 
        queryText?: string; 
        serie?: string; 
        materia?: string;
        status?: 'Não iniciado' | 'Concluído' | 'Em andamento' | 'all'; 
        scope: 'my_modules' | 'public';
    }) => {
        if (!user) return;
        
        // Persist Filters
        setModuleFilters({
            queryText: filters.queryText || '',
            serie: filters.serie || 'all',
            materia: filters.materia || 'all',
            status: filters.status || 'Em andamento',
            scope: filters.scope
        });

        setIsSearchingModules(true);
        setSearchedModules([]);

        try {
            let q = query(collection(db, "modules"), where("status", "==", "Ativo"));

            if (filters.scope === 'public') {
                q = query(q, where("visibility", "==", "public"));
            } else {
                const myClassIds = studentClasses.map(c => c.id);
                if (myClassIds.length === 0) {
                    setSearchedModules([]);
                    setIsSearchingModules(false);
                    // Silenciosamente retorna se não houver turmas (evita notificação de erro na inicialização)
                    return;
                }
                const classIdsToQuery = myClassIds.slice(0, 10);
                q = query(q, where("classIds", "array-contains-any", classIdsToQuery));
            }

            q = query(q, limit(20));

            if (filters.scope === 'public' && filters.serie && filters.serie !== 'all') {
                q = query(q, where("series", "array-contains", filters.serie));
            }
            
            const snap = await getDocs(q);
            let results = snap.docs.map(d => ({ id: d.id, ...d.data() } as Module));

            // Client Side Filtering
            if (filters.scope === 'my_modules' && filters.serie && filters.serie !== 'all') {
                results = results.filter(m => {
                    const series = Array.isArray(m.series) ? m.series : [m.series];
                    return series.includes(filters.serie!);
                });
            }

            if (filters.materia && filters.materia !== 'all') {
                results = results.filter(m => {
                    const mat = Array.isArray(m.materia) ? m.materia : [m.materia];
                    return mat.includes(filters.materia!);
                });
            }

            if (filters.queryText) {
                const lowerQuery = filters.queryText.toLowerCase();
                results = results.filter(m => m.title.toLowerCase().includes(lowerQuery));
            }

            const progressSnap = await getDocs(collection(db, "users", user.id, "modulesProgress"));
            const progressMap: Record<string, number> = {};
            progressSnap.forEach(d => progressMap[d.id] = d.data().progress);

            const finalModules = results.map(m => ({
                ...m,
                progress: progressMap[m.id] || 0
            }));

            let filteredByStatus = finalModules;
            if (filters.status && filters.status !== 'all') {
                filteredByStatus = finalModules.filter(m => {
                    if (filters.status === 'Concluído') return m.progress === 100;
                    if (filters.status === 'Não iniciado') return m.progress === 0;
                    if (filters.status === 'Em andamento') return m.progress > 0 && m.progress < 100;
                    return true;
                });
            }

            setSearchedModules(filteredByStatus);

        } catch (error) {
            console.error("Module search error:", error);
            addToast("Erro ao buscar módulos.", "error");
        } finally {
            setIsSearchingModules(false);
        }
    }, [user, studentClasses, addToast]);


    // --- SEARCH QUIZZES (On Demand) ---
    const searchQuizzes = useCallback(async (filters: { 
        serie?: string; 
        materia?: string;
        status?: 'feito' | 'nao_iniciado' | 'all';
    }) => {
        if (!user) return;
        setIsSearchingQuizzes(true);
        setSearchedQuizzes([]);

        try {
            let q = query(
                collection(db, "quizzes"),
                where("status", "==", "Ativo"),
                limit(20)
            );

            if (filters.serie && filters.serie !== 'all') {
                q = query(q, where("series", "array-contains", filters.serie));
            }

            const filterMateriaClientSide = filters.serie && filters.serie !== 'all' && filters.materia && filters.materia !== 'all';

            if (!filterMateriaClientSide && filters.materia && filters.materia !== 'all') {
                 q = query(q, where("materia", "array-contains", filters.materia));
            }

            const snap = await getDocs(q);
            let results = snap.docs.map(d => ({ id: d.id, ...d.data() } as Quiz));

            if (filterMateriaClientSide) {
                results = results.filter(qz => {
                    const mat = Array.isArray(qz.materia) ? qz.materia : [qz.materia];
                    return mat.includes(filters.materia!);
                });
            }

            const attemptsSnap = await getDocs(collection(db, "users", user.id, "quiz_results"));
            const attemptsMap: Record<string, number> = {};
            attemptsSnap.forEach(d => attemptsMap[d.id] = d.data().attempts || 0);

            const finalQuizzes = results.map(qz => ({
                ...qz,
                attempts: attemptsMap[qz.id] || 0
            }));

            let filteredByStatus = finalQuizzes;
            if (filters.status && filters.status !== 'all') {
                filteredByStatus = finalQuizzes.filter(qz => {
                    if (filters.status === 'feito') return qz.attempts > 0;
                    if (filters.status === 'nao_iniciado') return qz.attempts === 0;
                    return true;
                });
            }

            setSearchedQuizzes(filteredByStatus);

            if (filteredByStatus.length === 0) {
                addToast("Nenhum quiz encontrado.", "info");
            }

        } catch (error) {
            console.error("Quiz search error:", error);
            addToast("Erro ao buscar quizzes.", "error");
        } finally {
            setIsSearchingQuizzes(false);
        }
    }, [user, addToast]);


    // --- ACTIVITIES ---
    const searchActivities = useCallback(async (
        filters: { classId: string; materia: string; unidade: string },
        lastDoc?: QueryDocumentSnapshot | null
    ): Promise<{ activities: Activity[], lastDoc: QueryDocumentSnapshot | null }> => {
        if (!user) return { activities: [], lastDoc: null };
        
        try {
            let q = query(
                collection(db, "activities"),
                where("isVisible", "==", true),
                orderBy("createdAt", "desc"),
                limit(20)
            );

            if (filters.classId !== 'all') {
                q = query(q, where("classId", "==", filters.classId));
            } else {
                const myClassIds = studentClasses.map(c => c.id);
                if (myClassIds.length > 0) {
                    const classChunk = myClassIds.slice(0, 10);
                    q = query(q, where("classId", "in", classChunk));
                } else {
                    return { activities: [], lastDoc: null }; 
                }
            }

            if (filters.materia !== 'all') {
                q = query(q, where("materia", "==", filters.materia));
            }

            if (filters.unidade !== 'all') {
                q = query(q, where("unidade", "==", filters.unidade));
            }

            if (lastDoc) {
                q = query(q, startAfter(lastDoc));
            }

            const snap = await getDocs(q);
            const newLastDoc = snap.docs[snap.docs.length - 1] || null;
            
            const results = snap.docs.map(d => {
                const data = d.data();
                let className = data.className;
                if (!className || className === 'Turma desconhecida') {
                    const cls = studentClasses.find(c => c.id === data.classId);
                    if (cls) className = cls.name;
                }
                
                return {
                    id: d.id,
                    ...data,
                    className: className || 'Turma'
                } as Activity;
            });

            return { activities: results, lastDoc: newLastDoc };

        } catch (error) {
            console.error("Error searching activities:", error);
            addToast("Erro ao buscar atividades.", "error");
            return { activities: [], lastDoc: null };
        }
    }, [user, studentClasses, addToast]);


    // --- ACTIONS ---
    const handleJoinClass = async (code: string): Promise<boolean> => {
        if (!user) return false;
        try {
            const q = query(collection(db, "classes"), where("code", "==", code));
            const querySnapshot = await getDocs(q);

            if (querySnapshot.empty) {
                addToast("Turma não encontrada com este código.", "error");
                return false;
            }

            const classDoc = querySnapshot.docs[0];
            const classData = classDoc.data();

            if (classData.studentIds?.includes(user.id)) {
                const currentStudents = classData.students || [];
                const me = currentStudents.find((s: any) => s.id === user.id);
                
                if (me && me.status === 'inactive') {
                    const updatedStudents = currentStudents.map((s: any) => 
                        s.id === user.id ? { ...s, status: 'active' } : s
                    );
                    
                    await updateDoc(doc(db, "classes", classDoc.id), {
                        students: updatedStudents,
                        studentCount: increment(1)
                    });
                    addToast(`Bem-vindo de volta à turma ${classData.name}!`, "success");
                    await refreshContent(true);
                    return true;
                }

                addToast("Você já está nesta turma.", "info");
                return false;
            }

            const classRef = doc(db, "classes", classDoc.id);
            await updateDoc(classRef, {
                studentIds: arrayUnion(user.id),
                students: arrayUnion({ id: user.id, name: user.name, avatarUrl: user.avatarUrl || "", status: 'active' }),
                studentCount: increment(1)
            });

            addToast(`Você entrou na turma ${classData.name}!`, "success");
            await refreshContent(true); 
            return true;
        } catch (error) {
            console.error("Error joining class:", error);
            addToast("Erro ao entrar na turma.", "error");
            return false;
        }
    };

    const handleLeaveClass = async (classId: string) => {
        if (!user) return;
        try {
            const classRef = doc(db, "classes", classId);
            const classSnap = await getDoc(classRef);
            
            if (classSnap.exists()) {
                const classData = classSnap.data();
                const currentStudents = classData.students || [];
                
                const updatedStudents = currentStudents.map((s: any) => {
                    if (s.id === user.id) {
                        return { ...s, status: 'inactive' };
                    }
                    return s;
                });

                await updateDoc(classRef, {
                    students: updatedStudents,
                    studentCount: increment(-1)
                });

                setStudentClasses(prev => prev.filter(c => c.id !== classId));
                addToast("Você saiu da turma.", "success");
            }
        } catch (error) {
            console.error("Error leaving class:", error);
            addToast("Erro ao sair da turma. Verifique sua conexão.", "error");
            throw error;
        }
    };

    const handleActivitySubmit = async (activityId: string, content: string) => {
        if (!user) return;
        try {
            const activityRef = doc(db, "activities", activityId);
            const activitySnap = await getDoc(activityRef);
            
            if (!activitySnap.exists()) throw new Error("Atividade não existe");
            const activityData = activitySnap.data() as Activity;

            let answersMap: Record<string, string> = {};
            try { answersMap = JSON.parse(content); } catch { /* legacy */ }

            let calculatedGrade = 0;
            let hasTextQuestions = false;
            const items = activityData.items || [];

            if (items.length > 0) {
                items.forEach(item => {
                    if (item.type === 'text') {
                        hasTextQuestions = true;
                    } else if (item.type === 'multiple_choice' && item.correctOptionId) {
                        if (answersMap[item.id] === item.correctOptionId) {
                            calculatedGrade += (item.points || 0);
                        }
                    }
                });
            }

            const gradingMode = activityData.gradingConfig?.objectiveQuestions || 'automatic';
            let status: 'Aguardando correção' | 'Corrigido' = 'Aguardando correção';
            
            if (gradingMode === 'automatic' && !hasTextQuestions && items.length > 0) {
                status = 'Corrigido';
            }

            const submissionData: ActivitySubmission = {
                studentId: user.id,
                studentName: user.name,
                submissionDate: new Date().toISOString(),
                content: content,
                status: status,
            };

            if (status === 'Corrigido') {
                submissionData.grade = calculatedGrade;
                submissionData.gradedAt = new Date().toISOString();
                submissionData.feedback = "Correção automática.";
            }

            const submissionRef = doc(db, "activities", activityId, "submissions", user.id);
            await setDoc(submissionRef, { ...submissionData, timestamp: serverTimestamp() });

            const batch = writeBatch(db);
            const existingSubIndex = activityData.submissions?.findIndex(s => s.studentId === user.id) ?? -1;
            let newSubmissionsList = activityData.submissions || [];
            
            if (existingSubIndex > -1) {
                newSubmissionsList[existingSubIndex] = submissionData;
            } else {
                newSubmissionsList.push(submissionData);
            }

            batch.update(activityRef, {
                submissionCount: increment(existingSubIndex === -1 ? 1 : 0),
                pendingSubmissionCount: increment(status === 'Aguardando correção' && existingSubIndex === -1 ? 1 : 0),
                submissions: newSubmissionsList
            });

            await batch.commit();

            if (status === 'Corrigido') {
                 await createNotification({
                    userId: user.id, actorId: 'system', actorName: 'Sistema', type: 'activity_correction',
                    title: 'Atividade Corrigida Automaticamente', text: `Sua atividade "${activityData.title}" foi corrigida. Nota: ${calculatedGrade}`,
                    classId: activityData.classId!, activityId: activityId
                });
            }

            // PROCESSA GAMIFICAÇÃO (Atividade Enviada)
            // Incrementa stats de 'activitiesCompleted' e verifica conquistas
            const unlockedAchievements = await processGamificationEvent(user.id, 'activity_sent', 0);
            
            addToast("Atividade enviada com sucesso!", "success");
            
            if (unlockedAchievements.length > 0) {
                unlockedAchievements.forEach(ach => {
                    addToast(`🏆 Conquista Desbloqueada: ${ach.title}`, 'success');
                });
            }

        } catch (error) {
            console.error("Error submitting activity:", error);
            addToast("Erro ao enviar atividade.", "error");
        }
    };

    const handleModuleProgressUpdate = async (moduleId: string, progress: number) => {
        if (!user) return;
        try {
            const userProgRef = doc(db, "users", user.id, "modulesProgress", moduleId);
            await setDoc(userProgRef, {
                progress: Math.round(progress),
                lastUpdated: serverTimestamp()
            }, { merge: true });
            
            setInProgressModules(prev => prev.map(m => m.id === moduleId ? { ...m, progress } : m));
            setSearchedModules(prev => prev.map(m => m.id === moduleId ? { ...m, progress } : m));
        } catch (error) {
            console.error("Background progress save failed", error);
        }
    };

    const handleModuleComplete = async (moduleId: string) => {
        if (!user) return;
        try {
            const userProgRef = doc(db, "users", user.id, "modulesProgress", moduleId);
            await setDoc(userProgRef, {
                progress: 100,
                completedAt: serverTimestamp(),
                status: 'Concluído'
            }, { merge: true });

            // PROCESSA GAMIFICAÇÃO (Módulo Concluído)
            // Incrementa stats de 'modulesCompleted', adiciona 50 XP e verifica conquistas
            const unlockedAchievements = await processGamificationEvent(user.id, 'module_complete', 50);

            setInProgressModules(prev => prev.map(m => m.id === moduleId ? { ...m, progress: 100 } : m));
            setSearchedModules(prev => prev.map(m => m.id === moduleId ? { ...m, progress: 100 } : m));
            
            addToast("Módulo concluído! +50 XP", "success");
            
            if (unlockedAchievements.length > 0) {
                unlockedAchievements.forEach(ach => {
                    addToast(`🏆 Conquista Desbloqueada: ${ach.title}`, 'success');
                });
            }

        } catch (error) {
            console.error("Error completing module:", error);
            addToast("Erro ao concluir módulo.", "error");
        }
    };

    return {
        inProgressModules,
        searchedModules,
        searchedQuizzes,
        studentClasses,
        moduleFilters, // EXPOSED
        isLoading,
        isSearchingModules,
        isSearchingQuizzes,
        refreshContent,
        searchModules,
        searchQuizzes,
        searchActivities,
        handleJoinClass,
        handleLeaveClass,
        handleActivitySubmit,
        handleModuleProgressUpdate,
        handleModuleComplete,
        setSearchedQuizzes,
        setSearchedModules
    };
}
