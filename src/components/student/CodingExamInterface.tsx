
'use client';

import { useEffect, useReducer, useState, useCallback, useMemo } from 'react';
import type { Exam, StudentAnswer, TestCase, TestResult, StudentExam } from '@/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Loader2, AlertTriangle, ShieldAlert, Play, CheckCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { useRouter } from 'next/navigation';
import { doc, serverTimestamp } from 'firebase/firestore';
import { useFirestore, useUser, useDoc, useMemoFirebase, setDocumentNonBlocking } from '@/firebase';
import { useFullscreenEnforcement } from '@/hooks/use-fullscreen-enforcement';
import { executeCode, ExecuteCodeInput } from '@/ai/flows/execute-code-flow';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import Editor from '@monaco-editor/react';
import { v4 as uuidv4 } from 'uuid';
import { Label } from '../ui/label';
import { useTheme } from 'next-themes';
import { ThemeToggle } from '../layout/ThemeToggle';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

// --- State Management ---
type State = {
  timeLeft: number;
  examStarted: boolean;
  examFinished: boolean;
  answers: Map<string, StudentAnswer>;
  language: 'python' | 'cpp' | 'java' | 'javascript';
};

type Action =
  | { type: 'INITIALIZE'; payload: State }
  | { type: 'START_EXAM' }
  | { type: 'UPDATE_CODE'; payload: { questionId: string; sourceCode: string } }
  | { type: 'UPDATE_LANGUAGE'; payload: State['language'] }
  | { type: 'SET_RUN_RESULTS'; payload: { questionId: string; results: TestResult[] } }
  | { type: 'TICK_TIMER' }
  | { type: 'FINISH_EXAM' };

function examReducer(state: State, action: Action): State {
  switch (action.type) {
    case 'INITIALIZE':
      return action.payload;
    case 'START_EXAM':
      return { ...state, examStarted: true };
    case 'UPDATE_CODE': {
      const newAnswers = new Map(state.answers);
      const answer = newAnswers.get(action.payload.questionId) || { questionId: action.payload.questionId };
      newAnswers.set(action.payload.questionId, { ...answer, sourceCode: action.payload.sourceCode });
      return { ...state, answers: newAnswers };
    }
    case 'UPDATE_LANGUAGE':
      return { ...state, language: action.payload };
    case 'SET_RUN_RESULTS': {
      const newAnswers = new Map(state.answers);
      const answer = newAnswers.get(action.payload.questionId) || { questionId: action.payload.questionId };
      const allPassed = action.payload.results.every(r => r.isCorrect);
      
      const updatedAnswer: StudentAnswer = {
          ...answer,
          testResults: action.payload.results,
          totalPassed: action.payload.results.filter(r => r.isCorrect).length,
          totalCases: action.payload.results.length,
          status: allPassed ? 'answered' : 'not-answered',
          marks: allPassed ? 100 : 0
      };
      newAnswers.set(action.payload.questionId, updatedAnswer);
      return { ...state, answers: newAnswers };
    }
    case 'TICK_TIMER':
      if (state.timeLeft <= 1) {
        return { ...state, timeLeft: 0, examFinished: true };
      }
      return { ...state, timeLeft: state.timeLeft - 1 };
    case 'FINISH_EXAM':
      return { ...state, examFinished: true, timeLeft: 0 };
    default:
      return state;
  }
}

const ExamTimer = ({ timeLeft }: { timeLeft: number }) => {
  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  return (
    <div className={cn("text-xl font-bold font-mono", timeLeft < 300 && 'text-destructive')}>
      {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
    </div>
  );
};

export function CodingExamInterface({ examId }: { examId: string }) {
  const { toast } = useToast();
  const router = useRouter();
  const { user } = useUser();
  const firestore = useFirestore();
  const { theme } = useTheme();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExecutingCode, setIsExecutingCode] = useState(false);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);

  const examDocRef = useMemoFirebase(() => doc(firestore, 'exams', examId), [firestore, examId]);
  const { data: examData, isLoading: isExamLoading } = useDoc<Exam>(examDocRef);
  
  const studentExamDocRef = useMemoFirebase(() => {
    if (!user) return null;
    return doc(firestore, 'studentExams', `${user.uid}_${examId}`);
  }, [firestore, examId, user]);
  const { data: studentExamData, isLoading: isStudentExamLoading } = useDoc<StudentExam>(studentExamDocRef);

    const shuffledQuestions = useMemo(() => {
        if (!examData?.questions) return [];
        // Fisher-Yates shuffle algorithm
        const array = [...examData.questions];
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }, [examData?.questions]);

  const initialState: State | null = useMemo(() => {
    if (!examData) return null;
    
    const initialAnswers = new Map<string, StudentAnswer>();
    (shuffledQuestions).forEach(q => {
        const existingAnswer = studentExamData?.answers?.find(a => a.questionId === q.id);
        initialAnswers.set(q.id, {
            questionId: q.id,
            questionText: q.text,
            status: existingAnswer?.status || 'not-answered',
            sourceCode: existingAnswer?.sourceCode || '',
            testResults: existingAnswer?.testResults || [],
            totalPassed: existingAnswer?.totalPassed,
            totalCases: existingAnswer?.totalCases,
        });
    });

    return {
      timeLeft: examData.duration * 60,
      examStarted: false,
      examFinished: false,
      answers: initialAnswers,
      language: studentExamData?.language || examData.language || 'python',
    };
  }, [examData, studentExamData, shuffledQuestions]);

  const [state, dispatch] = useReducer(examReducer, initialState as State);

  useEffect(() => {
    if (initialState) {
      dispatch({ type: 'INITIALIZE', payload: initialState });
    }
  }, [initialState]);
  
  const handleRunCode = async () => {
    if (!state || !examData?.questions || shuffledQuestions.length === 0) return;
    const currentQuestion = shuffledQuestions[currentQuestionIndex];
    const currentAnswer = state.answers.get(currentQuestion?.id || '');
    if (!currentQuestion || !currentAnswer) return;

    setIsExecutingCode(true);
    try {
        const input: ExecuteCodeInput = {
            language: state.language,
            sourceCode: currentAnswer.sourceCode || '',
            testCases: currentQuestion.testCases || [],
        };
        const result = await executeCode(input);
        
        dispatch({ type: 'SET_RUN_RESULTS', payload: { questionId: currentQuestion.id, results: result.results } });

        if (result.results.some(r => r.error)) {
            toast({
                variant: 'destructive',
                title: 'Execution Error',
                description: 'One or more test cases resulted in an error.',
            });
        } else if (result.totalPassed === result.totalCases) {
            toast({
                title: 'All Test Cases Passed!',
                description: 'This question is now marked as answered.',
                className: 'bg-green-100 text-green-800'
            });
        } else {
             toast({
                title: 'Some Test Cases Failed',
                description: `${result.totalPassed} out of ${result.totalCases} passed. Review the output.`,
            });
        }
    } catch (e: any) {
        toast({ variant: 'destructive', title: 'Error', description: e.message });
    } finally {
        setIsExecutingCode(false);
    }
  };


  const handleSubmitExam = useCallback(async (autoSubmitDetails?: { autoSubmitted: boolean; exitCount: number }) => {
    if (!state || !user || !examData || isSubmitting || !studentExamDocRef) return;
  
    setIsSubmitting(true);
    toast({ title: "Submitting exam...", description: "Please wait while we process your submission." });
  
    const finalAnswers: StudentAnswer[] = [];
    let totalMarks = 0;
  
    for (const question of (shuffledQuestions || [])) {
      const answer = state.answers.get(question.id);
      if (!answer || !answer.sourceCode) {
        finalAnswers.push({ 
            questionId: question.id, 
            questionText: question.text,
            testResults: [], 
            status: 'not-answered',
            marks: 0,
            sourceCode: '',
        });
        continue;
      }
  
      const input: ExecuteCodeInput = {
        language: state.language,
        sourceCode: answer.sourceCode,
        testCases: question.testCases || [],
      };
  
      try {
        const result = await executeCode(input);
        const marksForQuestion = result.totalCases > 0 ? (result.totalPassed / result.totalCases) * 100 : 0;
        totalMarks += marksForQuestion;
        
        finalAnswers.push({
          ...answer,
          questionId: question.id,
          questionText: question.text,
          testResults: result.results,
          totalPassed: result.totalPassed,
          totalCases: result.totalCases,
          marks: marksForQuestion,
          status: result.totalPassed === result.totalCases ? 'answered' : 'not-answered',
        });
  
      } catch (e) {
        finalAnswers.push({
          ...answer,
          questionId: question.id,
          questionText: question.text,
          testResults: (question.testCases || []).map(tc => ({...tc, id: uuidv4(), actualOutput: "Execution Error on Submit", isCorrect: false, error: "Submission execution failed" })),
          status: 'not-answered',
          marks: 0,
        });
      }
    }

    const overallScore = shuffledQuestions.length > 0 ? totalMarks / shuffledQuestions.length : 0;
  
    const submissionPayload: Partial<StudentExam> = {
      studentId: user.uid,
      examId: examId,
      examTitle: examData.title,
      answers: finalAnswers,
      score: overallScore,
      timeFinished: serverTimestamp(),
      language: state.language,
    };
    
    if (autoSubmitDetails) {
        submissionPayload.autoSubmitted = autoSubmitDetails.autoSubmitted;
        submissionPayload.exitCount = autoSubmitDetails.exitCount;
        submissionPayload.status = 'suspicious';
    } else {
        submissionPayload.status = 'graded';
    }

    // Clean up undefined values before submission
    if(submissionPayload.language === undefined) delete submissionPayload.language;
  
    try {
      setDocumentNonBlocking(studentExamDocRef, submissionPayload, { merge: true });
  
      dispatch({ type: 'FINISH_EXAM' });
  
      toast({
        title: "Exam Submitted!",
        description: `Your answers have been submitted.`,
      });
      router.push('/student/dashboard');
  
    } catch (error) {
      console.error("Submission failed", error);
      toast({ variant: 'destructive', title: 'Submission Failed' });
      setIsSubmitting(false);
    }
  }, [state, user, examData, examId, isSubmitting, toast, studentExamDocRef, router, shuffledQuestions]);

    const handleAutoSubmit = useCallback(() => {
        const exitCount = parseInt(localStorage.getItem(`fullscreenExitCount_${examId}`) || '0', 10);
        handleSubmitExam({ autoSubmitted: true, exitCount: exitCount });
    }, [examId, handleSubmitExam]);

  const { isFullscreen, isPageVisible, exitCount, MAX_EXITS, enterFullscreen, countdown } = useFullscreenEnforcement(
      examId,
      handleAutoSubmit,
      state?.examStarted,
      state?.examFinished
    );
  
    useEffect(() => {
        if (!state || !state.examStarted || state.examFinished) return;
        const timer = setInterval(() => dispatch({ type: 'TICK_TIMER' }), 1000);
        return () => clearInterval(timer);
    }, [state?.examStarted, state?.examFinished]);

    useEffect(() => {
        if (state?.timeLeft === 0 && state.examStarted && !state.examFinished) {
            handleAutoSubmit();
        }
    }, [state?.timeLeft, state?.examStarted, state?.examFinished, handleAutoSubmit]);

    useEffect(() => {
        const header = document.querySelector('.exam-layout-header');

        if (state?.examStarted && !state.examFinished) {
            header?.classList.add('hidden');
        }
        return () => {
            header?.classList.remove('hidden');
        }
    }, [state?.examStarted, state?.examFinished, toast]);

    useEffect(() => {
        const preventAction = (e: Event) => {
            e.preventDefault();
            toast({
                variant: 'destructive',
                title: 'Action Disabled',
                description: 'This action is not allowed during the exam.',
            });
        };
        if (state?.examStarted && !state.examFinished) {
            document.addEventListener('contextmenu', preventAction);
            document.addEventListener('copy', preventAction);
        }
        return () => {
            document.removeEventListener('contextmenu', preventAction);
            document.removeEventListener('copy', preventAction);
        }
    }, [state?.examStarted, state?.examFinished, toast]);

  if (isExamLoading || isStudentExamLoading) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-background">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="mt-4 text-muted-foreground">Loading Exam...</p>
      </div>
    );
  }
  
  if (!examData || !state) {
    return (
        <div className="flex h-screen w-full flex-col items-center justify-center bg-background text-center">
            <h2 className="text-2xl font-bold">Exam Not Found</h2>
            <p className="mt-2 text-muted-foreground">The exam you are looking for does not exist or has been removed.</p>
        </div>
    );
  }

  if (studentExamData) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-background text-center p-4">
        <ShieldAlert className="h-16 w-16 text-destructive mb-4" />
        <h2 className="text-2xl font-bold">Exam Already Completed</h2>
        <p className="mt-2 text-muted-foreground max-w-md">
          You have already submitted this exam. You cannot take it again.
        </p>
        <Button onClick={() => router.push('/student/dashboard')} className="mt-6">
          Return to Dashboard
        </Button>
      </div>
    );
  }

  if (!shuffledQuestions || shuffledQuestions.length === 0) {
    return (
        <div className="flex h-screen w-full flex-col items-center justify-center bg-background text-center p-4">
            <ShieldAlert className="h-16 w-16 text-destructive mb-4" />
            <h2 className="text-2xl font-bold">Exam Not Ready</h2>
            <p className="mt-2 text-muted-foreground max-w-md">
                This coding exam has no questions assigned to it yet. Please contact your instructor.
            </p>
            <Button onClick={() => router.push('/student/dashboard')} className="mt-6">
                Return to Dashboard
            </Button>
        </div>
    );
  }

  const currentQuestion = shuffledQuestions[currentQuestionIndex];
  const currentAnswer = state.answers.get(currentQuestion.id);

  const elapsedTime = examData.duration * 60 - state.timeLeft;
  const minimumTimeInSeconds = (examData.minimumTime ?? examData.duration * 0.5) * 60;
  const isSubmitDisabled = elapsedTime < minimumTimeInSeconds;
  
  const submitButtonTooltip = isSubmitDisabled
    ? `You can submit after ${Math.ceil((minimumTimeInSeconds - elapsedTime) / 60)} more minutes.`
    : "This will submit your code for final grading. You cannot change it after submitting.";


  if (!state.examStarted) {
      return (
          <div className="container flex items-center justify-center min-h-[calc(100vh-4rem)]">
            <Card className="w-full max-w-2xl text-center">
                <CardHeader>
                    <CardTitle className="text-3xl">{examData.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p>{examData.description}</p>
                    <div className="flex justify-center gap-8 text-lg">
                        <p><strong>Duration:</strong> {examData.duration} minutes</p>
                        <p><strong>Questions:</strong> {shuffledQuestions.length}</p>
                    </div>
                    <p className="text-sm text-muted-foreground">This exam will be conducted in fullscreen mode.</p>
                    <Button size="lg" onClick={() => {
                        enterFullscreen();
                        dispatch({type: 'START_EXAM'});
                    }}>Start Exam</Button>
                </CardContent>
            </Card>
          </div>
      );
  }

    if (state.examStarted && (!isFullscreen || !isPageVisible)) {
        return (
        <div className="flex h-screen w-full flex-col items-center justify-center bg-background text-center p-4">
            <AlertTriangle className="h-16 w-16 text-destructive mb-4" />
            <h2 className="text-2xl font-bold">You have left the secure exam environment.</h2>
            {countdown !== null ? (
                <div>
                    <p className="text-destructive font-bold text-4xl my-4">{countdown}</p>
                    <p className="mt-2 text-muted-foreground max-w-md">
                        You must return to full-screen immediately. Failure to do so will result in the automatic submission of your exam.
                    </p>
                </div>
            ) : (
                 <p className="mt-2 text-muted-foreground max-w-md">
                    To continue the exam, you must return to full-screen.
                </p>
            )}
            <p className="font-bold text-lg mt-4">
            Warnings used: <span className="text-destructive">{exitCount} / {MAX_EXITS}</span>
            </p>
            <Button onClick={enterFullscreen} size="lg" className="mt-6">
            Return to Exam
            </Button>
        </div>
        );
    }
  
    if (state.examFinished) {
        return (
            <div className="flex h-screen w-full flex-col items-center justify-center bg-background">
                <Loader2 className="h-12 w-12 animate-spin text-primary" />
                <p className="mt-4 text-muted-foreground">{isSubmitting ? "Submitting your exam..." : "Exam Finished!"}</p>
            </div>
        );
    }


  return (
    <div className="flex flex-col h-screen bg-background text-foreground p-4 gap-4">
        <header className="flex items-center justify-between bg-muted p-2 rounded-md">
             <div className="flex items-center gap-4">
                <h1 className="text-xl font-bold">{examData.title}</h1>
                <span className="text-sm text-muted-foreground">Question {currentQuestionIndex + 1} of {shuffledQuestions.length}</span>
            </div>
            <div className="flex items-center gap-4">
                <Select
                    value={state.language}
                    onValueChange={(value: any) => dispatch({ type: 'UPDATE_LANGUAGE', payload: value })}
                    >
                    <SelectTrigger className="w-[120px]">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="python">Python</SelectItem>
                        <SelectItem value="cpp">C++</SelectItem>
                        <SelectItem value="java">Java</SelectItem>
                        <SelectItem value="javascript">JavaScript</SelectItem>
                    </SelectContent>
                </Select>
                 <ThemeToggle />
                 <AlertDialog>
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className="inline-block">
                                <AlertDialogTrigger asChild>
                                    <Button variant="destructive" disabled={isSubmitting || isSubmitDisabled}>End Exam</Button>
                                </AlertDialogTrigger>
                                </div>
                            </TooltipTrigger>
                            {isSubmitDisabled && (
                            <TooltipContent>
                                <p>{submitButtonTooltip}</p>
                            </TooltipContent>
                            )}
                        </Tooltip>
                    </TooltipProvider>

                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                            <AlertDialogDescription>{submitButtonTooltip}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleSubmitExam()}>Submit</AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
                <div className="flex items-center gap-2 p-2 border border-border rounded-md"><CardTitle className='text-lg'>Time Left</CardTitle><ExamTimer timeLeft={state.timeLeft} /></div>
            </div>
        </header>

        <div className="flex-1 grid grid-cols-2 gap-4 overflow-hidden">
            <div className="flex flex-col gap-4 overflow-y-auto pr-2">
                <Card className="flex-grow">
                    <CardHeader><CardTitle>Problem Statement</CardTitle></CardHeader>
                    <CardContent>
                        <p className="whitespace-pre-wrap">{currentQuestion.text}</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>Test Cases</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {(currentQuestion.testCases || []).map((tc, index) => (
                            <div key={tc.id}>
                                <Label className="font-semibold">Test Case {index + 1} Input:</Label>
                                <pre className="p-2 bg-muted rounded-md text-sm font-mono mt-1">{tc.input || '""'}</pre>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            </div>
            
            <div className="flex flex-col gap-4">
                <div className="flex-1 flex flex-col rounded-md border border-border overflow-hidden">
                    <Editor
                      height="100%"
                      language={state.language}
                      theme={theme === 'dark' ? 'vs-dark' : 'light'}
                      value={currentAnswer?.sourceCode || ''}
                      onChange={(value) => dispatch({ type: 'UPDATE_CODE', payload: { questionId: currentQuestion.id, sourceCode: value || '' } })}
                      onMount={(editor, monaco) => {
                        editor.onDidPaste((e) => {
                            toast({
                                variant: 'destructive',
                                title: 'Pasting is Disabled',
                                description: 'Pasting content into the editor is not allowed.',
                            });
                        });
                        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, () => {});
                        editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Insert, () => {});
                        editor.updateOptions({ contextmenu: false });
                      }}
                      options={{
                        fontSize: 14,
                        minimap: { enabled: false },
                        contextmenu: false,
                        padding: { top: 16 },
                      }}
                    />
                </div>
                
                <div className='flex justify-between items-start'>
                    <div className="flex gap-2">
                        <Button onClick={handleRunCode} disabled={isExecutingCode} className="bg-green-600 hover:bg-green-700">
                            {isExecutingCode ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                            Run Code
                        </Button>
                    </div>
                    <div className='flex items-center gap-2'>
                        {shuffledQuestions.map((q, index) => (
                            <Button key={q.id} size="icon" variant={index === currentQuestionIndex ? 'default' : 'outline'} onClick={() => setCurrentQuestionIndex(index)}>
                                {index + 1}
                            </Button>
                        ))}
                    </div>
                </div>

                <Card className="min-h-[12rem]">
                    <CardHeader>
                        <div className='flex flex-row justify-between items-center'>
                            <CardTitle>Output</CardTitle>
                        </div>
                    </CardHeader>
                    <CardContent>
                       {isExecutingCode ? (
                             <div className='flex items-center gap-2 text-muted-foreground'><Loader2 className="h-4 w-4 animate-spin" /><span>Executing...</span></div>
                        ) : currentAnswer?.testResults && currentAnswer.testResults.length > 0 ? (
                             <Tabs defaultValue="test-case-0" className="w-full">
                                <TabsList>
                                    {currentAnswer.testResults.map((result, index) => (
                                        <TabsTrigger key={`trigger-${index}`} value={`test-case-${index}`}>
                                            <span className={cn('mr-2', result.isCorrect ? 'text-green-600' : 'text-red-600')}>
                                                {result.isCorrect ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                                            </span>
                                            Test Case {index + 1}
                                        </TabsTrigger>
                                    ))}
                                </TabsList>
                                {currentAnswer.testResults.map((result, index) => (
                                    <TabsContent key={`content-${index}`} value={`test-case-${index}`} className="mt-4">
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <h4 className="font-semibold text-sm mb-1">Your Output:</h4>
                                                <pre className="text-sm whitespace-pre-wrap bg-muted rounded-md p-2 min-h-[40px]">{result.actualOutput || (result.error ? result.error : 'No output.')}</pre>
                                            </div>
                                             <div>
                                                <h4 className="font-semibold text-sm mb-1">Expected Output:</h4>
                                                <pre className="text-sm whitespace-pre-wrap bg-muted rounded-md p-2 min-h-[40px]">{result.expectedOutput || 'No expected output.'}</pre>
                                            </div>
                                        </div>
                                    </TabsContent>
                                ))}
                            </Tabs>
                        ) : (
                            <p className="text-muted-foreground">Run code to see the output for all test cases.</p>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    </div>
  );
}
